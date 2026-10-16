// -----------------------------------------------------------------------------
// The motors of the hub, as Gladys sees them.
//
// The Fleet keeps what the integration knows about each motor (its type, the
// last state the hub gave, where it last came to rest), and turns hub answers
// into Gladys states and scene events:
//
//   - discovery: the device list, then one cache read per motor so the
//     features match the hardware (position or not, battery or not);
//   - polling: a cache read at the interval of the configuration;
//   - commands: the order, then quick reads while the motor runs, so the
//     position follows the movement instead of jumping at the next poll;
//   - scene events: a motor moved without Gladys (remote, app, wall switch), a
//     battery fell under the threshold. One event per transition.
//
// Every read is a `ReadDevice`: the hub answers from memory, with no radio
// traffic, so a motor's battery never pays for the polling.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import {
  buildDevice,
  defaultName,
  idsOf,
  macOf,
  operationFor,
  readState,
  statesOf,
} from './motor.js';
import { fireSceneEvent, SCENE_TRIGGERS } from '../capabilities/scenes.js';
import { OPERATIONS } from '../connector/protocol.js';

const logger = createLogger({ name: 'motors' });

/** After a Gladys order, a movement is Gladys' own for this long. */
export const COMMAND_WINDOW_MS = 120_000;
/** Reads while a motor runs. */
export const TRACK_INTERVAL_MS = 2_000;
/** No motor runs longer than this: tracking stops anyway. */
export const TRACK_MAX_MS = 120_000;
/** A position must change by this much to count as a movement. */
const MOVE_THRESHOLD = 2;
/** A low battery is "low" again only once it climbed this far over the threshold. */
const BATTERY_HYSTERESIS = 5;
/** An unchanged state is published again this often. */
const STATE_HEARTBEAT_MS = 30 * 60 * 1000;
/** Between the two steps of an identification. */
const IDENTIFY_PAUSE_MS = 1_500;
/** Gladys' poll ticks drift: a read due within half a poll period runs now. */
const POLL_TOLERANCE_MS = 15_000;

export class Fleet {
  /**
   * @param {object} options
   * @param {object} options.gladys the SDK client
   * @param {() => import('../connector/client.js').ConnectorClient} options.client
   * @param {() => object} options.config the current normalized config
   * @param {{ now?: () => number, setInterval?: Function, clearInterval?: Function }} [options.clock]
   */
  constructor({ gladys, client, config, clock = {} }) {
    this.gladys = gladys;
    this.client = client;
    this.config = config;
    this.now = clock.now ?? Date.now;
    this.setInterval = clock.setInterval ?? setInterval;
    this.clearInterval = clock.clearInterval ?? clearInterval;
    /** mac → { mac, deviceType, info, rest, lastCommandAt, batteryLow, tracker } */
    this.motors = new Map();
  }

  /** The discovery payload: every motor of the hub, its features fitted to it. */
  async discover() {
    const hub = await this.client().getDeviceList();
    const devices = [];
    for (const { mac, deviceType } of hub.motors) {
      const motor = this.remember(mac, deviceType);
      try {
        motor.info = await this.client().readDevice(mac, deviceType);
      } catch (err) {
        if (err.code === 'UNREACHABLE') {
          throw err;
        }
        // A motor the hub knows but never heard from: published anyway, with
        // the features a reporting motor has.
        logger.warn(`Motor ${mac} could not be read: ${err.message}`);
      }
      devices.push(buildDevice(this.gladys, motor));
    }
    logger.info(`${devices.length} motor(s) on the hub`);
    return devices;
  }

  remember(mac, deviceType) {
    let motor = this.motors.get(mac);
    if (!motor) {
      motor = {
        mac,
        deviceType,
        info: undefined,
        rest: {},
        lastCommandAt: 0,
        batteryLow: undefined,
      };
      this.motors.set(mac, motor);
    }
    if (deviceType) {
      motor.deviceType = deviceType;
    }
    return motor;
  }

  /** The motor behind a Gladys device or feature external id. */
  async motorOf(externalId) {
    const mac = macOf(this.gladys, externalId);
    if (!mac) {
      throw new Error(`Not a Dooya Connector device: ${externalId}`);
    }
    const known = this.motors.get(mac);
    if (known?.deviceType) {
      return known;
    }
    // Restarted, not discovered yet: the device list says what this motor is.
    return this.remember(mac, await this.client().deviceTypeOf(mac));
  }

  /** The name the user gave the motor in Gladys, the default one otherwise. */
  nameOf(motor) {
    const device = this.gladys.devices?.find(
      (candidate) => candidate.external_id === idsOf(this.gladys, motor.mac).device,
    );
    return device?.name ?? defaultName(motor);
  }

  /**
   * Read a motor and publish what changed.
   * @param {object} motor
   * @param {object} [data] an answer already in hand (a write ack), read otherwise
   * @returns {Promise<ReturnType<typeof readState>>}
   */
  async refresh(motor, data) {
    const state = await this.publish(motor, data);
    await this.watchMovement(motor, state);
    await this.watchBattery(motor, state.battery);
    if (state.rails.some((rail) => rail.moving)) {
      this.track(motor);
    }
    return state;
  }

  /** Read a motor (unless `data` is given) and publish the states that changed. */
  async publish(motor, data) {
    const answer = data ?? (await this.client().readDevice(motor.mac, motor.deviceType));
    motor.info = { ...motor.info, ...answer };
    const state = readState(motor, answer);
    const states = statesOf(this.gladys, motor, state);
    if (states.length > 0) {
      // Only what changed, so a fleet of resting blinds stays far under the 300
      // states per minute of the host API; an unchanged value is re-sent every
      // 30 minutes so it stays recently dated in Gladys.
      await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT_MS });
    }
    return state;
  }

  /** A motor that came to rest somewhere new, without a Gladys order: a scene event. */
  async watchMovement(motor, state) {
    const byGladys = this.now() - motor.lastCommandAt < COMMAND_WINDOW_MS;
    for (const rail of state.rails) {
      if (rail.position === null || rail.moving) {
        continue;
      }
      const before = motor.rest[rail.key];
      motor.rest[rail.key] = rail.position;
      if (before === undefined || byGladys || Math.abs(rail.position - before) < MOVE_THRESHOLD) {
        continue;
      }
      logger.info(
        `"${this.nameOf(motor)}" moved without Gladys: ${before} % -> ${rail.position} %`,
      );
      await fireSceneEvent(this.gladys, SCENE_TRIGGERS.MOVED_OUTSIDE_GLADYS, {
        device: idsOf(this.gladys, motor.mac).device,
        device_name: this.nameOf(motor),
        direction: rail.position > before ? 'up' : 'down',
        position: rail.position,
      });
    }
  }

  async watchBattery(motor, battery) {
    if (battery === null) {
      return;
    }
    const threshold = this.config().battery_low_threshold;
    if (motor.batteryLow === undefined) {
      // The first reading sets the baseline: a restart is not a transition.
      motor.batteryLow = battery < threshold;
      return;
    }
    if (motor.batteryLow && battery >= threshold + BATTERY_HYSTERESIS) {
      motor.batteryLow = false;
      return;
    }
    if (!motor.batteryLow && battery < threshold) {
      motor.batteryLow = true;
      logger.warn(`"${this.nameOf(motor)}": battery low (${battery} %)`);
      await fireSceneEvent(this.gladys, SCENE_TRIGGERS.BATTERY_LOW, {
        device: idsOf(this.gladys, motor.mac).device,
        device_name: this.nameOf(motor),
        battery,
      });
    }
  }

  /**
   * Send an order, publish the state the hub acknowledged, and follow the
   * movement.
   */
  async command(motor, data) {
    motor.lastCommandAt = this.now();
    logger.info(`"${this.nameOf(motor)}" <- ${JSON.stringify(data)}`);
    const ack = await this.client().writeDevice(motor.mac, data, motor.deviceType);
    // The ack carries the state from before the order: tracking reads the rest.
    motor.info = { ...motor.info, ...ack };
    this.track(motor);
    return ack;
  }

  /**
   * Make a motor show itself: one small step up, then back down. The blind
   * ends where it was, and the user knows which one Gladys calls by that name.
   */
  async identify(motor, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    await this.command(motor, operationFor(motor, OPERATIONS.JOG_UP));
    await pause(IDENTIFY_PAUSE_MS);
    await this.command(motor, operationFor(motor, OPERATIONS.JOG_DOWN));
  }

  /** Every motor the same order (open / close / stop). */
  async commandAll(operation) {
    if (this.motors.size === 0) {
      await this.discover();
    }
    let sent = 0;
    let failed = 0;
    for (const motor of this.motors.values()) {
      try {
        await this.command(motor, operationFor(motor, operation));
        sent += 1;
      } catch (err) {
        failed += 1;
        logger.warn(`"${this.nameOf(motor)}" did not take the order: ${err.message}`);
      }
    }
    return { sent, failed };
  }

  /** Quick reads while a motor runs, until it rests or runs too long. */
  track(motor) {
    if (motor.tracker) {
      motor.tracker.until = this.now() + TRACK_MAX_MS;
      return;
    }
    const tracker = { until: this.now() + TRACK_MAX_MS, quiet: 0, busy: false };
    tracker.timer = this.setInterval(async () => {
      if (tracker.busy) {
        return;
      }
      tracker.busy = true;
      try {
        const state = await this.publish(motor);
        const moving = state.rails.some((rail) => rail.moving);
        tracker.quiet = moving ? 0 : tracker.quiet + 1;
        // Two quiet reads in a row: the motor rests (the first one can come
        // before it started).
        if (tracker.quiet >= 2 || this.now() >= tracker.until) {
          this.untrack(motor);
          await this.watchMovement(motor, state);
          await this.watchBattery(motor, state.battery);
        }
      } catch (err) {
        logger.debug(`Tracking "${this.nameOf(motor)}" stopped: ${err.message}`);
        this.untrack(motor);
      } finally {
        tracker.busy = false;
      }
    }, TRACK_INTERVAL_MS);
    motor.tracker = tracker;
  }

  untrack(motor) {
    if (motor.tracker) {
      this.clearInterval(motor.tracker.timer);
      motor.tracker = undefined;
    }
  }

  /** Stop every timer (disconnection, shutdown, new configuration). */
  stop() {
    for (const motor of this.motors.values()) {
      this.untrack(motor);
    }
  }

  /** Forget everything: another hub, or another key. */
  reset() {
    this.stop();
    this.motors.clear();
  }

  /** Is this external id one of our motors? */
  isMotor(externalId) {
    return macOf(this.gladys, externalId) !== null;
  }

  /** The motor devices the user created in Gladys. */
  createdDevices() {
    return (this.gladys.devices ?? []).filter((device) => macOf(this.gladys, device.external_id));
  }

  /** The transport badge of every created motor: the hub answered, or not. */
  transportEntries(reachable) {
    const transport = reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    return this.createdDevices().map((device) => ({ external_id: device.external_id, transport }));
  }

  /** The motors whose last battery reading is under the threshold. */
  lowBatteries() {
    return [...this.motors.values()].filter((motor) => motor.batteryLow === true);
  }
}

/**
 * The `onPoll` dispatcher: Gladys polls every 30 s, the motor is read at the
 * interval of the configuration (`poll_frequency`, seconds). A motor followed
 * after an order is read by its tracker already.
 *
 * Resolves `true` when the motor was read.
 */
export function createPoller(fleet) {
  const lastReads = new Map();
  return async function pollDevice(device, config) {
    const motor = await fleet.motorOf(device.external_id);
    const now = fleet.now();
    const lastRead = lastReads.get(motor.mac);
    if (motor.tracker) {
      return false;
    }
    if (
      lastRead !== undefined &&
      now - lastRead < config.poll_frequency * 1000 - POLL_TOLERANCE_MS
    ) {
      return false;
    }
    lastReads.set(motor.mac, now);
    await fleet.refresh(motor);
    return true;
  };
}
