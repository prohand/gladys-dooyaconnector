// -----------------------------------------------------------------------------
// Scene triggers and scene actions (Gladys 5.1+).
//
// Triggers say "this happened" — fired by the code that sees it:
//   - moved_outside_gladys   a motor came to rest somewhere new without a
//                            Gladys order (remote, Connector app, wall switch);
//   - battery_low            a motor battery fell under the threshold;
//   - hub_connection_changed the hub stopped answering, or answers again.
//
// Actions are operations a scene author places in a scene:
//   - favorite_position      send a motor to its favourite position;
//   - jog                    move a motor one small step up or down;
//   - set_tilt               turn the slats of a venetian blind;
//   - move_all               open, close or stop every motor of the hub.
//
// Keys are stored in users' scenes: never rename one (test/manifest.test.js
// ties them to the manifest). No action ever fires an event: a movement
// Gladys ordered is not "outside Gladys", so a scene cannot loop through us.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { maxAngle, OPERATIONS } from '../connector/protocol.js';
import { operationFor } from '../devices/motor.js';

const logger = createLogger({ name: 'scenes' });

export const SCENE_TRIGGERS = {
  MOVED_OUTSIDE_GLADYS: 'moved_outside_gladys',
  BATTERY_LOW: 'battery_low',
  HUB_CONNECTION_CHANGED: 'hub_connection_changed',
};

export const SCENE_ACTIONS = {
  FAVORITE_POSITION: 'favorite_position',
  JOG: 'jog',
  SET_TILT: 'set_tilt',
  MOVE_ALL: 'move_all',
};

/** The `direction` values of `moved_outside_gladys`. */
export const DIRECTIONS = { UP: 'up', DOWN: 'down' };

/** The `status` values of `hub_connection_changed`. */
export const HUB_STATUSES = { LOST: 'lost', RESTORED: 'restored' };

/** The `order` values of `move_all`. */
export const MOVE_ALL_ORDERS = {
  open: OPERATIONS.OPEN,
  close: OPERATIONS.CLOSE,
  stop: OPERATIONS.STOP,
};

/**
 * Fire a scene trigger. An event Gladys refuses (rate limit, Gladys older
 * than 5.1) is logged, never thrown: it must not break the poll that saw it.
 */
export async function fireSceneEvent(gladys, key, data) {
  try {
    await gladys.publishSceneEvent(key, data);
  } catch (err) {
    logger.warn(`Scene event ${key} not delivered: ${err.message}`);
  }
}

/**
 * Scene action handlers, keyed by the manifest `scene_actions` keys.
 * Each one receives the fleet and the RESOLVED fields, and resolves the
 * declared outputs (or `undefined`).
 */
export const SCENE_ACTION_HANDLERS = {
  async [SCENE_ACTIONS.FAVORITE_POSITION](fleet, fields) {
    const motor = await fleet.motorOf(fields.device);
    await fleet.command(motor, operationFor(motor, OPERATIONS.GO_FAVORITE));
  },

  async [SCENE_ACTIONS.JOG](fleet, fields) {
    const motor = await fleet.motorOf(fields.device);
    const operation =
      fields.direction === DIRECTIONS.DOWN ? OPERATIONS.JOG_DOWN : OPERATIONS.JOG_UP;
    await fleet.command(motor, operationFor(motor, operation));
  },

  async [SCENE_ACTIONS.SET_TILT](fleet, fields) {
    const motor = await fleet.motorOf(fields.device);
    const angle = Math.min(180, Math.max(0, Number(fields.angle)));
    if (!Number.isFinite(angle)) {
      throw new Error(`Invalid angle: ${fields.angle}`);
    }
    // The scene speaks 0-180°, a quarter-turn motor 0-90 in its own unit.
    const limit = maxAngle(motor.deviceType, motor.info?.type);
    await fleet.command(motor, { targetAngle: Math.round((angle * limit) / 180) });
  },

  async [SCENE_ACTIONS.MOVE_ALL](fleet, fields) {
    const operation = MOVE_ALL_ORDERS[fields.order];
    if (operation === undefined) {
      throw new Error(`Unknown order: ${fields.order}`);
    }
    return fleet.commandAll(operation);
  },
};
