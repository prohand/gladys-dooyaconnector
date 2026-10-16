import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorClient } from '../src/connector/client.js';
import { HUB_MAC, KEY, rollerBlind, startFakeHub } from './helpers/fakeHub.js';

const MOTOR = rollerBlind().mac;

async function withHub(t, options) {
  const hub = await startFakeHub(options);
  t.after(() => hub.close());
  const client = new ConnectorClient({
    host: '127.0.0.1',
    port: hub.port,
    key: KEY,
    timeoutMs: 100,
  });
  return { hub, client };
}

test('the device list names the hub and its motors, the hub itself excluded', async (t) => {
  const { client } = await withHub(t);
  const list = await client.getDeviceList();
  assert.equal(list.mac, HUB_MAC);
  assert.equal(list.firmware, 'A1.1.2_B0.1.4');
  assert.deepEqual(list.motors, [{ mac: MOTOR, deviceType: '10000000' }]);
});

test('a read asks for the device list first, then sends the access token', async (t) => {
  const { hub, client } = await withHub(t);
  const data = await client.readDevice(MOTOR);
  assert.equal(data.currentPosition, 50);
  assert.deepEqual(
    hub.received.map((request) => request.msgType),
    ['GetDeviceList', 'ReadDevice'],
  );
  assert.equal(hub.received[1].deviceType, '10000000');
});

test('a write moves the motor', async (t) => {
  const { hub, client } = await withHub(t);
  await client.writeDevice(MOTOR, { targetPosition: 20 });
  assert.equal(hub.motors.get(MOTOR).data.currentPosition, 20);
});

test('a refused key is reported as such, after one fresh token', async (t) => {
  const { hub, client } = await withHub(t);
  hub.key = 'ffffffff-ffff-ff';
  await assert.rejects(client.readDevice(MOTOR), { code: 'BAD_KEY' });
  // One retry with a new token, then the verdict.
  assert.equal(hub.received.filter((r) => r.msgType === 'GetDeviceList').length, 2);
});

test('a hub that restarted with a new token is followed', async (t) => {
  const { hub, client } = await withHub(t);
  await client.getDeviceList();
  hub.token = '8765432187654321';
  const data = await client.readDevice(MOTOR);
  assert.equal(data.currentPosition, 50);
});

test('a silent hub is retried, then called unreachable once', async (t) => {
  const { hub, client } = await withHub(t);
  await client.getDeviceList();
  const events = [];
  client.on('reachability', (reachable) => events.push(reachable));
  hub.silent = true;
  await assert.rejects(client.readDevice(MOTOR), { code: 'UNREACHABLE' });
  assert.equal(hub.received.filter((r) => r.msgType === 'ReadDevice').length, 3, 'three attempts');
  assert.deepEqual(events, [false]);
  hub.silent = false;
  await client.readDevice(MOTOR);
  assert.deepEqual(events, [false, true]);
});

test('no IP address, no request', async () => {
  const client = new ConnectorClient({ host: '', key: KEY });
  await assert.rejects(client.getDeviceList(), { code: 'NOT_CONFIGURED' });
});

test('requests run one at a time', async (t) => {
  const { hub, client } = await withHub(t);
  await client.getDeviceList();
  await Promise.all([client.readDevice(MOTOR), client.readGateway(), client.readDevice(MOTOR)]);
  assert.equal(hub.received.length, 4);
});
