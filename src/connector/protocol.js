// -----------------------------------------------------------------------------
// The Connector local protocol: JSON over UDP.
//
// Every Dooya Connector hub (DD7002B, DD7006…, also sold as Brel, Bloc Blinds,
// Coulisse Motion, Smart Blinds…) speaks the same LAN protocol:
//
//   - requests are JSON datagrams sent to UDP port 32100 of the hub;
//   - the hub answers in unicast, to the port the request came from;
//   - it also pushes `Report` and `Heartbeat` datagrams to the multicast group
//     238.0.0.18:32101. Those never reach an integration container (bridge
//     network), so this integration reads the hub's cache instead: a
//     `ReadDevice` answers from memory, without any radio traffic.
//
// Every write carries an `AccessToken`: the `token` the hub hands out in its
// `GetDeviceListAck`, encrypted with AES-128-ECB under the 16-character key the
// Connector app shows. A wrong key is answered with an `actionResult` error.
//
// Positions: the hub counts from the top, 0 = fully open, 100 = fully closed.
// Gladys counts the other way (100 = open), hence `toGladysPosition`.
// -----------------------------------------------------------------------------

import { createCipheriv } from 'node:crypto';

export const UDP_PORT = 32100;

/** The `deviceType` of a hub (bridge) in a device list. */
export const GATEWAY_DEVICE_TYPES = ['02000001', '02000002'];

/** The `deviceType` of the motors a hub drives. */
export const MOTOR_DEVICE_TYPES = {
  BLIND: '10000000',
  TOP_DOWN_BOTTOM_UP: '10000001',
  DOUBLE_ROLLER: '10000002',
  SUNBLIND: '10000011',
  WIFI_CURTAIN: '22000000',
  WIFI_BLIND: '22000002',
  WIFI_GATE: '22000005',
};

/** `data.operation` values: orders sent, and the movement a motor reports. */
export const OPERATIONS = {
  CLOSE: 0,
  OPEN: 1,
  STOP: 2,
  STATUS_QUERY: 5,
  JOG_UP: 7,
  JOG_DOWN: 8,
  SET_FAVORITE: 11,
  GO_FAVORITE: 12,
};

/** `data.type`: what the motor is mounted in (as set in the Connector app). */
export const BLIND_TYPES = {
  1: 'Roller blind',
  2: 'Venetian blind',
  3: 'Roman blind',
  4: 'Honeycomb blind',
  5: 'Shangri-La blind',
  6: 'Roller shutter',
  7: 'Roller gate',
  8: 'Awning',
  9: 'Top down bottom up',
  10: 'Day night blind',
  11: 'Dimming blind',
  12: 'Curtain',
  13: 'Curtain (left)',
  14: 'Curtain (right)',
  15: 'Roller tilt motor',
  17: 'Double roller',
  21: 'Vertical blind (left)',
  22: 'Wood shutter',
  24: 'Radio receiver',
  26: 'Skylight blind',
  27: 'Dual shade',
  28: 'Vertical blind',
  29: 'Vertical blind (right)',
  40: 'Woven wood shades',
  43: 'Switch',
  44: 'Insect screen',
  57: 'Triangle blind',
};

const CURTAIN_BLIND_TYPES = [12, 13, 14];

/** Blind types whose slats turn 90° at most (the others turn 180°). */
const QUARTER_TURN_BLIND_TYPES = [5];

/** `data.wirelessMode`: how much the motor tells the hub. */
export const WIRELESS_MODES = {
  UNI_DIRECTION: 0,
  BI_DIRECTION: 1,
  BI_DIRECTION_LIMITS: 2,
  WIFI: 3,
  VIRTUAL_PERCENTAGE_LIMITS: 4,
  OTHERS: 5,
};

/** `data.voltageMode`. */
export const VOLTAGE_MODES = { AC: 0, DC: 1 };

/**
 * The `msgID` the hub expects: the UTC time, to the millisecond, as digits.
 * @param {Date} [date]
 */
export function messageId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 17);
}

/**
 * The `AccessToken` of the writes: the hub token encrypted with the app key.
 *
 * Both are 16 characters, one AES block: no padding, exactly what the hub
 * computes on its side.
 *
 * @param {string} token from `GetDeviceListAck`
 * @param {string} key the 16-character key of the Connector app
 * @returns {string} uppercase hexadecimal
 */
export function accessToken(token, key) {
  const keyBytes = Buffer.from(String(key), 'utf8');
  const tokenBytes = Buffer.from(String(token), 'utf8');
  if (keyBytes.length !== 16) {
    throw new ConnectorError(
      'BAD_KEY_FORMAT',
      `The key must be 16 characters long, got ${keyBytes.length}`,
    );
  }
  if (tokenBytes.length !== 16) {
    throw new ConnectorError('BAD_RESPONSE', 'The hub sent a token that is not 16 characters');
  }
  const cipher = createCipheriv('aes-128-ecb', keyBytes, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(tokenBytes), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

/** An error of the hub or of the way to it, with a stable `code`. */
export class ConnectorError extends Error {
  /**
   * @param {'NOT_CONFIGURED'|'BAD_KEY_FORMAT'|'BAD_KEY'|'UNREACHABLE'|'REFUSED'|'BAD_RESPONSE'|'UNKNOWN_DEVICE'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

/** A copy of a message that is safe to log: no token, no access token. */
export function redact(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }
  const copy = { ...message };
  for (const key of ['token', 'AccessToken']) {
    if (copy[key] !== undefined) {
      copy[key] = '***';
    }
  }
  return copy;
}

/** A MAC as the hub writes it, lowercase hexadecimal — usable in an external id. */
export function normalizeMac(mac) {
  return String(mac ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
}

export function isGateway(deviceType) {
  return GATEWAY_DEVICE_TYPES.includes(String(deviceType));
}

export function isTopDownBottomUp(deviceType) {
  return String(deviceType) === MOTOR_DEVICE_TYPES.TOP_DOWN_BOTTOM_UP;
}

export function isCurtain(deviceType, blindType) {
  return (
    String(deviceType) === MOTOR_DEVICE_TYPES.WIFI_CURTAIN ||
    CURTAIN_BLIND_TYPES.includes(Number(blindType))
  );
}

/**
 * Does the motor report where it is? A one-way radio motor only takes orders,
 * and a "limits only" one only says when it reaches an end stop.
 */
export function reportsPosition(wirelessMode) {
  const mode = Number(wirelessMode);
  return mode !== WIRELESS_MODES.UNI_DIRECTION && mode !== WIRELESS_MODES.BI_DIRECTION_LIMITS;
}

/** Does the motor tell the hub anything at all? */
export function reportsState(wirelessMode) {
  return Number(wirelessMode) !== WIRELESS_MODES.UNI_DIRECTION;
}

/** The widest slat angle of a motor, in the hub's own unit. */
export function maxAngle(deviceType, blindType) {
  if (
    String(deviceType) === MOTOR_DEVICE_TYPES.DOUBLE_ROLLER ||
    QUARTER_TURN_BLIND_TYPES.includes(Number(blindType))
  ) {
    return 90;
  }
  return 180;
}

export function clampPercent(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.min(100, Math.max(0, number));
}

/** Hub position (0 = open) → Gladys position (100 = open). */
export function toGladysPosition(hubPosition) {
  const position = clampPercent(hubPosition);
  return position === null ? null : 100 - position;
}

/** Gladys position (100 = open) → hub position (0 = open). */
export function toHubPosition(gladysPosition) {
  const position = clampPercent(gladysPosition);
  return position === null ? null : 100 - position;
}

/**
 * Battery percentage from the raw `batteryLevel` (hundredths of a volt).
 *
 * The motors only give a voltage: the percentage follows the pack it reveals
 * (2, 3 or 4 Li-ion cells), with the same bounds as the reference Home
 * Assistant library. Mains motors report more than 100 V: `null`.
 *
 * @param {number} raw
 * @returns {number|null}
 */
export function batteryPercent(raw) {
  const volts = Number(raw) / 100;
  if (!Number.isFinite(volts) || volts >= 100) {
    return null;
  }
  let percent;
  if (volts <= 0) {
    percent = 0;
  } else if (volts <= 9.4) {
    percent = ((volts - 6.2) * 100) / (8.4 - 6.2);
  } else if (volts <= 13.6) {
    percent = ((volts - 10.27) * 100) / (12.34 - 10.27);
  } else if (volts <= 19) {
    percent = ((volts - 14.6) * 100) / (16.8 - 14.6);
  } else {
    return null;
  }
  return clampPercent(percent);
}

/** A motor moving right now, from its reported `operation`. */
export function isMoving(operation) {
  const value = Number(operation);
  return value === OPERATIONS.OPEN || value === OPERATIONS.CLOSE;
}
