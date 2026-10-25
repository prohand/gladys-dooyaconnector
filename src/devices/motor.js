// -----------------------------------------------------------------------------
// Device type: MOTOR driven by the Connector hub.
//
// One Gladys device per motor: roller blinds, shutters, venetian blinds,
// awnings, curtains, gates… The hub says what each motor is mounted in
// (`data.type`), whether it reports its position (`data.wirelessMode`) and
// whether it runs on battery (`data.voltageMode`); the features follow:
//
//   - `state` (open / stop / close), always;
//   - `position` (0-100 %, 100 = open), when the motor reports it;
//   - `battery` (%), for a battery motor;
//   - a "top down bottom up" blind has two rails, so two of each:
//     `top-state`, `top-position`, `bottom-state`, `bottom-position`.
//
// Curtains get the `curtain` category, everything else `shutter`, so Gladys
// shows the right card. Feature keys are stored by Gladys: never rename them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import {
  batteryPercent,
  BLIND_TYPES,
  isCurtain,
  isMoving,
  isTopDownBottomUp,
  OPERATIONS,
  reportsPosition,
  reportsState,
  toGladysPosition,
  toHubPosition,
  VOLTAGE_MODES,
} from '../connector/protocol.js';

/** The type part of the device external ids: `ext:<selector>:motor:<mac>`. */
export const DEVICE_TYPE = 'motor';

export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
  BATTERY: 'battery',
  TOP_STATE: 'top-state',
  TOP_POSITION: 'top-position',
  BOTTOM_STATE: 'bottom-state',
  BOTTOM_POSITION: 'bottom-position',
};

/** Gladys spells a cover state 1 = open, 0 = stop, -1 = close. */
export const COVER_STATES = { OPEN: 1, STOP: 0, CLOSE: -1 };

/** The rails of a motor: one for most, two for a top down bottom up blind. */
const RAILS = {
  single: [{ suffix: '', state: FEATURES.STATE, position: FEATURES.POSITION }],
  dual: [
    { suffix: '_T', state: FEATURES.TOP_STATE, position: FEATURES.TOP_POSITION, label: 'top' },
    {
      suffix: '_B',
      state: FEATURES.BOTTOM_STATE,
      position: FEATURES.BOTTOM_POSITION,
      label: 'bottom',
    },
  ],
};

export function railsOf(motor) {
  return isTopDownBottomUp(motor.deviceType) ? RAILS.dual : RAILS.single;
}

export function idsOf(gladys, mac) {
  return gladys.externalIds(DEVICE_TYPE, mac);
}

/** The mac of a motor, read back from one of its device or feature external ids. */
export function macOf(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  return externalId.slice(prefix.length).split(':')[0] || null;
}

/** "Roller blind 0001": the hub has no names, the last digits tell motors apart. */
export function defaultName(motor) {
  const label =
    BLIND_TYPES[motor.info?.type] ?? (isCurtain(motor.deviceType) ? 'Curtain' : 'Blind');
  return `${label} ${motor.mac.slice(-4)}`;
}

/**
 * The discovery payload of one motor.
 * @param {object} gladys
 * @param {{ mac: string, deviceType: string, info?: object }} motor `info` is
 *   the last `ReadDevice` data, unknown when the motor never answered
 */
export function buildDevice(gladys, motor) {
  const ids = idsOf(gladys, motor.mac);
  const info = motor.info ?? {};
  const category = isCurtain(motor.deviceType, info.type)
    ? DEVICE_FEATURE_CATEGORIES.CURTAIN
    : DEVICE_FEATURE_CATEGORIES.SHUTTER;
  const types =
    DEVICE_FEATURE_TYPES[category === DEVICE_FEATURE_CATEGORIES.CURTAIN ? 'CURTAIN' : 'SHUTTER'];
  // A motor that never answered is assumed to report its position: the
  // feature is then there for when it does.
  const withPosition = info.wirelessMode === undefined || reportsPosition(info.wirelessMode);
  const hasFeedback = info.wirelessMode === undefined || reportsState(info.wirelessMode);

  const features = [];
  for (const rail of railsOf(motor)) {
    const suffix = rail.label ? ` (${rail.label})` : '';
    features.push({
      name: `State${suffix}`,
      external_id: ids.feature(rail.state),
      category,
      type: types.STATE,
      min: -1,
      max: 1,
      read_only: false,
      has_feedback: hasFeedback,
      keep_history: true,
    });
    if (withPosition) {
      features.push({
        name: `Position${suffix}`,
        external_id: ids.feature(rail.position),
        category,
        type: types.POSITION,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: hasFeedback,
        keep_history: true,
      });
    }
  }
  if (Number(info.voltageMode) === VOLTAGE_MODES.DC) {
    features.push({
      name: 'Battery',
      external_id: ids.feature(FEATURES.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  return {
    name: defaultName(motor),
    external_id: ids.device,
    // Reads come from the hub's memory, so a 30 s pace costs no radio traffic;
    // the configured interval is applied on top (see createPoller).
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_30_SECONDS,
    params: [
      { name: 'MAC', value: motor.mac },
      { name: 'DEVICE_TYPE', value: motor.deviceType },
    ],
    features,
  };
}

/**
 * The Gladys cover state of a rail: the direction while it moves, then where it
 * stopped — open at the top, closed at the bottom, "stop" in between.
 */
export function coverState(operation, gladysPosition) {
  if (Number(operation) === OPERATIONS.OPEN) {
    return COVER_STATES.OPEN;
  }
  if (Number(operation) === OPERATIONS.CLOSE) {
    return COVER_STATES.CLOSE;
  }
  if (gladysPosition === 100) {
    return COVER_STATES.OPEN;
  }
  if (gladysPosition === 0) {
    return COVER_STATES.CLOSE;
  }
  return COVER_STATES.STOP;
}

/**
 * What the hub said about a motor, read as Gladys values.
 * @returns {{ rails: { key: string, operation: number|null, position: number|null, moving: boolean }[], battery: number|null }}
 */
export function readState(motor, data = {}) {
  const rails = railsOf(motor).map((rail) => {
    const operation = data[`operation${rail.suffix}`];
    const raw = data[`currentPosition${rail.suffix}`];
    const position =
      reportsPosition(data.wirelessMode ?? motor.info?.wirelessMode) && raw !== undefined
        ? toGladysPosition(raw)
        : null;
    return {
      key: rail.state,
      positionKey: rail.position,
      operation: operation === undefined ? null : Number(operation),
      position,
      moving: isMoving(operation),
    };
  });
  const rawBattery = data.batteryLevel ?? data.batteryLevel_B ?? data.batteryLevel_T;
  const dc = Number(data.voltageMode ?? motor.info?.voltageMode) === VOLTAGE_MODES.DC;
  return {
    rails,
    battery: dc && rawBattery !== undefined ? batteryPercent(rawBattery) : null,
  };
}

/** The `publishStates` entries of a state read by `readState`. */
export function statesOf(gladys, motor, state) {
  const ids = idsOf(gladys, motor.mac);
  const entries = [];
  for (const rail of state.rails) {
    if (rail.operation !== null || rail.position !== null) {
      entries.push({
        device_feature_external_id: ids.feature(rail.key),
        state: coverState(rail.operation, rail.position),
      });
    }
    if (rail.position !== null) {
      entries.push({
        device_feature_external_id: ids.feature(rail.positionKey),
        state: rail.position,
      });
    }
  }
  if (state.battery !== null) {
    entries.push({
      device_feature_external_id: ids.feature(FEATURES.BATTERY),
      state: state.battery,
    });
  }
  return entries;
}

/**
 * The hub order for a Gladys command on one feature.
 * @returns {object|null} the `data` of the `WriteDevice`, `null` for a feature
 *   that takes no command
 */
export function commandFor(gladys, motor, featureExternalId, value) {
  const ids = idsOf(gladys, motor.mac);
  for (const rail of railsOf(motor)) {
    if (featureExternalId === ids.feature(rail.state)) {
      const state = Number(value);
      let operation = OPERATIONS.STOP;
      if (state === COVER_STATES.OPEN) {
        operation = OPERATIONS.OPEN;
      } else if (state === COVER_STATES.CLOSE) {
        operation = OPERATIONS.CLOSE;
      }
      return { [`operation${rail.suffix}`]: operation };
    }
    if (featureExternalId === ids.feature(rail.position)) {
      const position = toHubPosition(value);
      if (position === null) {
        throw new Error(`Invalid position: ${value}`);
      }
      return { [`targetPosition${rail.suffix}`]: position };
    }
  }
  return null;
}

/** The hub order that moves every rail of a motor the same way. */
export function operationFor(motor, operation) {
  return Object.fromEntries(railsOf(motor).map((rail) => [`operation${rail.suffix}`, operation]));
}
