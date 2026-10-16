// -----------------------------------------------------------------------------
// Unicast UDP client of one Connector hub.
//
// The rules the hub imposes, and how they are met here:
//
//   - One question at a time. The hub answers on the port the request came
//     from, with nothing that ties an answer to its question for sure: requests
//     are queued, each on its own short-lived socket.
//   - UDP loses datagrams. A request without answer is sent again, three times
//     in all (as the reference implementation does), before the hub is called
//     unreachable.
//   - A long device list comes in several datagrams of about 1 KB: after a
//     full-size one, the client listens a little longer for the next part.
//   - The token can change (hub restarted). An `actionResult` carrying a new
//     token is answered by re-computing the access token and asking again,
//     once.
//
// The key, the token and the access token are never logged.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  accessToken,
  ConnectorError,
  isGateway,
  messageId,
  normalizeMac,
  redact,
  UDP_PORT,
} from './protocol.js';

const logger = createLogger({ name: 'connector' });

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_ATTEMPTS = 3;
// A datagram this long is probably one part of a longer answer.
const PART_SIZE = Math.floor(0.9 * 1024);
const NEXT_PART_TIMEOUT_MS = 200;

export class ConnectorClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host IPv4 address of the hub
   * @param {string} options.key 16-character key of the Connector app
   * @param {number} [options.port] UDP port of the hub (tests only)
   * @param {number} [options.timeoutMs] wait for an answer, per attempt
   * @param {number} [options.attempts] attempts before giving up
   */
  constructor({ host, key, port = UDP_PORT, timeoutMs = DEFAULT_TIMEOUT_MS, attempts }) {
    super();
    this.host = host;
    this.key = key;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts ?? DEFAULT_ATTEMPTS;
    this.token = null;
    this.accessToken = null;
    /** `true` once the hub answered, `false` once it stopped, `null` before. */
    this.reachable = null;
    /** What the last device list said about the hub itself. */
    this.hub = null;
    /** mac → deviceType, from the last device list. */
    this.deviceTypes = new Map();
    this.queue = Promise.resolve();
  }

  /**
   * The hub, its firmware and its motors. Also refreshes the token.
   * @returns {Promise<{ mac: string, deviceType: string, protocolVersion: string, firmware: string|null, motors: { mac: string, deviceType: string }[] }>}
   */
  async getDeviceList() {
    const answers = await this.send({ msgType: 'GetDeviceList' }, { expect: 'GetDeviceListAck' });
    const [first] = answers;
    this.setToken(first.token);
    const motors = [];
    for (const answer of answers) {
      for (const entry of answer.data ?? []) {
        if (isGateway(entry.deviceType) || !entry.mac) {
          continue;
        }
        const mac = normalizeMac(entry.mac);
        if (!motors.some((motor) => motor.mac === mac)) {
          motors.push({ mac, deviceType: String(entry.deviceType) });
        }
      }
    }
    this.deviceTypes = new Map(motors.map((motor) => [motor.mac, motor.deviceType]));
    this.hub = {
      mac: normalizeMac(first.mac),
      deviceType: String(first.deviceType ?? ''),
      protocolVersion: first.ProtocolVersion ?? null,
      firmware: first.fwVersion ?? null,
      motors,
    };
    return this.hub;
  }

  /**
   * The state of the hub itself: `{ currentState, numberOfDevices, RSSI }`.
   */
  async readGateway() {
    const hub = this.hub ?? (await this.getDeviceList());
    return this.readDevice(hub.mac, hub.deviceType);
  }

  /**
   * The last state a motor reported, from the hub's memory: no radio traffic.
   * @returns {Promise<object>} the `data` of the answer
   */
  async readDevice(mac, deviceType) {
    const answer = await this.authenticated(
      { msgType: 'ReadDevice', mac, deviceType: deviceType ?? (await this.deviceTypeOf(mac)) },
      'ReadDeviceAck',
    );
    return answer.data ?? {};
  }

  /**
   * Send an order to a motor (`{ operation }`, `{ targetPosition }`…).
   * @returns {Promise<object>} the `data` of the answer: the motor state as the hub knows it
   */
  async writeDevice(mac, data, deviceType) {
    const answer = await this.authenticated(
      {
        msgType: 'WriteDevice',
        mac,
        deviceType: deviceType ?? (await this.deviceTypeOf(mac)),
        data,
      },
      'WriteDeviceAck',
    );
    return answer.data ?? {};
  }

  /** The `deviceType` of a motor, from the device list (asked once when unknown). */
  async deviceTypeOf(mac) {
    if (!this.deviceTypes.has(mac)) {
      await this.getDeviceList();
    }
    const deviceType = this.deviceTypes.get(mac);
    if (!deviceType) {
      throw new ConnectorError('UNKNOWN_DEVICE', `The hub does not know the motor ${mac}`);
    }
    return deviceType;
  }

  setToken(token) {
    if (!token) {
      throw new ConnectorError('BAD_RESPONSE', 'The hub sent no token');
    }
    if (token !== this.token) {
      this.token = token;
      this.accessToken = accessToken(token, this.key);
    }
  }

  /** A request that needs the access token, renewed once when the hub refuses it. */
  async authenticated(message, expect, retried = false) {
    if (!this.accessToken) {
      await this.getDeviceList();
    }
    const [answer] = await this.send({ ...message, AccessToken: this.accessToken }, { expect });
    if (answer.actionResult === undefined) {
      return answer;
    }
    const result = String(answer.actionResult);
    if (answer.token && answer.token !== this.token && !retried) {
      logger.info('The hub changed its token, asking again');
      this.setToken(answer.token);
      return this.authenticated(message, expect, true);
    }
    if (/token/i.test(result)) {
      if (!retried) {
        // The token may have changed without the hub saying so (restart).
        this.accessToken = null;
        this.token = null;
        return this.authenticated(message, expect, true);
      }
      throw new ConnectorError('BAD_KEY', `The hub refused the key: ${result}`);
    }
    throw new ConnectorError('REFUSED', `The hub refused ${message.msgType}: ${result}`);
  }

  /**
   * Queue a request: one at a time, answers matched by `msgType`.
   * @returns {Promise<object[]>} the datagrams of the answer, parsed
   */
  send(message, { expect }) {
    const run = () => this.exchange(message, expect);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async exchange(message, expect) {
    if (!this.host) {
      throw new ConnectorError('NOT_CONFIGURED', 'The IP address of the hub is not set');
    }
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const request = { ...message, msgID: messageId() };
      logger.debug(`-> ${JSON.stringify(redact(request))}`);
      try {
        const answers = await this.once(request, expect);
        for (const answer of answers) {
          logger.debug(`<- ${JSON.stringify(redact(answer))}`);
        }
        this.setReachable(true);
        return answers;
      } catch (err) {
        lastError = err;
        if (err.code !== 'UNREACHABLE') {
          break;
        }
        logger.debug(`No answer to ${message.msgType} (attempt ${attempt}/${this.attempts})`);
      }
    }
    if (lastError.code === 'UNREACHABLE') {
      this.setReachable(false);
    }
    throw lastError;
  }

  /** One datagram out, the answer in, on a socket of its own. */
  once(request, expect) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const answers = [];
      let timer;
      let done = false;
      const finish = (err) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        socket.removeAllListeners('message');
        socket.close();
        if (err) {
          reject(err);
        } else {
          resolve(answers);
        }
      };
      const wait = (ms, onTimeout) => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, ms);
      };

      const unreachable = (err) =>
        finish(
          new ConnectorError(
            'UNREACHABLE',
            `The hub at ${this.host} cannot be reached: ${err.code ?? err.message}`,
          ),
        );
      socket.on('error', unreachable);
      socket.on('message', (buffer) => {
        let answer;
        try {
          answer = JSON.parse(buffer.toString('utf8'));
        } catch {
          logger.debug('Ignored a datagram that is not JSON');
          return;
        }
        // An error is answered without the expected type, with an actionResult.
        if (answer.msgType !== expect && answer.actionResult === undefined) {
          return;
        }
        answers.push(answer);
        if (buffer.length < PART_SIZE || answer.actionResult !== undefined) {
          finish();
          return;
        }
        wait(NEXT_PART_TIMEOUT_MS, () => finish());
      });

      wait(this.timeoutMs, () =>
        answers.length > 0
          ? finish()
          : finish(
              new ConnectorError(
                'UNREACHABLE',
                `The hub at ${this.host} did not answer ${request.msgType}`,
              ),
            ),
      );
      socket.send(Buffer.from(JSON.stringify(request)), this.port, this.host, (err) => {
        if (err) {
          unreachable(err);
        }
      });
    });
  }

  setReachable(reachable) {
    if (this.reachable === reachable) {
      return;
    }
    this.reachable = reachable;
    this.emit('reachability', reachable);
  }
}
