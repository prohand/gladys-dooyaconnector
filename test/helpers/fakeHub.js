// -----------------------------------------------------------------------------
// A fake Connector hub: a real UDP socket on 127.0.0.1 that speaks the hub
// protocol (GetDeviceList, ReadDevice, WriteDevice), checks the access token
// and moves its motors instantly. No network beyond the loopback.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { accessToken } from '../../src/connector/protocol.js';

export const HUB_MAC = 'f0f5bd3a1b2c';
export const KEY = '12ab345c-d67e-8f';

/** A battery roller blind that reports its position, half closed. */
export function rollerBlind(overrides = {}) {
  return {
    mac: `${HUB_MAC}0001`,
    deviceType: '10000000',
    data: {
      type: 1,
      operation: 2,
      currentPosition: 50,
      currentAngle: 0,
      currentState: 3,
      voltageMode: 1,
      batteryLevel: 1200,
      wirelessMode: 1,
      RSSI: -70,
    },
    ...overrides,
  };
}

export async function startFakeHub({ motors = [rollerBlind()], token = 'AbCdEfGh12345678' } = {}) {
  const socket = dgram.createSocket('udp4');
  const hub = {
    token,
    key: KEY,
    silent: false,
    /** Every request received, parsed. */
    received: [],
    motors: new Map(motors.map((motor) => [motor.mac, structuredClone(motor)])),
    gateway: { currentState: 1, numberOfDevices: motors.length, RSSI: -55 },
    port: 0,
    /** Move a motor as a remote would, behind Gladys' back. */
    set(mac, data) {
      Object.assign(hub.motors.get(mac).data, data);
    },
    close: () => new Promise((resolve) => socket.close(resolve)),
  };

  const answer = (message, rinfo) =>
    socket.send(Buffer.from(JSON.stringify(message)), rinfo.port, rinfo.address);

  socket.on('message', (buffer, rinfo) => {
    const request = JSON.parse(buffer.toString('utf8'));
    hub.received.push(request);
    if (hub.silent) {
      return;
    }
    if (request.msgType === 'GetDeviceList') {
      answer(
        {
          msgType: 'GetDeviceListAck',
          mac: HUB_MAC,
          deviceType: '02000002',
          ProtocolVersion: '0.9',
          fwVersion: 'A1.1.2_B0.1.4',
          token: hub.token,
          data: [
            { mac: HUB_MAC, deviceType: '02000002' },
            ...[...hub.motors.values()].map(({ mac, deviceType }) => ({ mac, deviceType })),
          ],
        },
        rinfo,
      );
      return;
    }
    if (request.AccessToken !== accessToken(hub.token, hub.key)) {
      answer({ msgType: `${request.msgType}Ack`, actionResult: 'AccessToken error' }, rinfo);
      return;
    }
    if (request.mac === HUB_MAC) {
      answer(
        { msgType: 'ReadDeviceAck', mac: HUB_MAC, deviceType: '02000002', data: hub.gateway },
        rinfo,
      );
      return;
    }
    const motor = hub.motors.get(request.mac);
    if (!motor) {
      answer({ msgType: `${request.msgType}Ack`, actionResult: 'device not exist' }, rinfo);
      return;
    }
    if (request.msgType === 'WriteDevice') {
      const before = { ...motor.data };
      applyOrder(motor, request.data);
      // Like the real hub, the ack carries the state from before the order.
      answer(
        { msgType: 'WriteDeviceAck', mac: motor.mac, deviceType: motor.deviceType, data: before },
        rinfo,
      );
      return;
    }
    answer(
      { msgType: 'ReadDeviceAck', mac: motor.mac, deviceType: motor.deviceType, data: motor.data },
      rinfo,
    );
  });

  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  hub.port = socket.address().port;
  return hub;
}

function applyOrder(motor, order) {
  for (const suffix of ['', '_T', '_B']) {
    const operation = order[`operation${suffix}`];
    if (operation === 0 || operation === 1) {
      motor.data[`currentPosition${suffix}`] = operation === 1 ? 0 : 100;
    }
    if (order[`targetPosition${suffix}`] !== undefined) {
      motor.data[`currentPosition${suffix}`] = order[`targetPosition${suffix}`];
    }
  }
  if (order.targetAngle !== undefined) {
    motor.data.currentAngle = order.targetAngle;
  }
  motor.data.operation = 2;
  motor.lastOrder = order;
}
