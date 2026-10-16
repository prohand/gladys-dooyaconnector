import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { ConnectorClient } from '../src/connector/client.js';
import { COMMAND_WINDOW_MS } from '../src/devices/index.js';
import { KEY, rollerBlind, startFakeHub } from './helpers/fakeHub.js';
import { manualClock } from './helpers/manualClock.js';

const MOTOR = rollerBlind().mac;

/** A connected integration on a fake hub, its motor created in Gladys. */
async function setup(t, { motors, config = {} } = {}) {
  const hub = await startFakeHub(motors ? { motors } : undefined);
  const clock = manualClock();
  const gladys = createFakeGladys({ config: { gateway_ip: '127.0.0.1', key: KEY, ...config } });
  const app = registerHandlers(gladys, {
    clock,
    pause: async () => {},
    createClient: (cfg) =>
      new ConnectorClient({ host: cfg.gateway_ip, key: cfg.key, port: hub.port, timeoutMs: 100 }),
  });
  t.after(async () => {
    app.stop();
    await hub.close();
  });
  await gladys.connect();
  const device = gladys.fake.discoveredDevices[0];
  if (device) {
    await gladys.fake.deviceCreated(device);
  }
  return { hub, gladys, app, clock, device };
}

// Let the reachability listener (not awaited by the client) finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

test('on connection, the motors of the hub are discovered with fitted features', async (t) => {
  const { gladys, device } = await setup(t);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(device.name, 'Roller blind 0001');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['state', 'position', 'battery'],
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: device.external_id,
    transport: 'local',
  });
});

test('a created motor publishes its state at once, Gladys way round', async (t) => {
  const { gladys, device } = await setup(t);
  assert.equal(gladys.fake.lastState(feature(device, 'position').external_id), 50);
  assert.equal(gladys.fake.lastState(feature(device, 'state').external_id), 0, 'half: stop');
  assert.equal(gladys.fake.lastState(feature(device, 'battery').external_id), 84);
});

test('a position set in Gladys reaches the hub inverted, and is followed until it rests', async (t) => {
  const { hub, gladys, device, clock } = await setup(t);
  const position = feature(device, 'position');
  const ack = await gladys.fake.setValue(device, position, 80);
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(hub.motors.get(MOTOR).lastOrder, { targetPosition: 20 });
  await clock.tick(10_000);
  assert.equal(gladys.fake.lastState(position.external_id), 80);
  assert.equal(clock.pending, 1, 'only the hub check is left: tracking stopped');
});

test('open / stop / close become the hub operations', async (t) => {
  const { hub, gladys, device } = await setup(t);
  const state = feature(device, 'state');
  await gladys.fake.setValue(device, state, 1);
  assert.deepEqual(hub.motors.get(MOTOR).lastOrder, { operation: 1 });
  await gladys.fake.setValue(device, state, -1);
  assert.deepEqual(hub.motors.get(MOTOR).lastOrder, { operation: 0 });
  await gladys.fake.setValue(device, state, 0);
  assert.deepEqual(hub.motors.get(MOTOR).lastOrder, { operation: 2 });
});

test('the poll follows the configured interval', async (t) => {
  const { hub, gladys, device, clock } = await setup(t, { config: { poll_frequency: 120 } });
  const reads = () => hub.received.filter((r) => r.msgType === 'ReadDevice' && r.mac === MOTOR);
  const before = reads().length;
  await gladys.fake.poll(device);
  await clock.tick(30_000);
  await gladys.fake.poll(device);
  assert.equal(reads().length, before + 1, 'the second poll came too soon');
  await clock.tick(90_000);
  await gladys.fake.poll(device);
  assert.equal(reads().length, before + 2);
});

test('a blind moved by a remote fires moved_outside_gladys, an order from Gladys does not', async (t) => {
  const { hub, gladys, device, clock } = await setup(t);
  await gladys.fake.poll(device);
  hub.set(MOTOR, { currentPosition: 0 });
  await clock.tick(60_000);
  await gladys.fake.poll(device);
  assert.equal(gladys.fake.sceneEvents.length, 1);
  assert.deepEqual(gladys.fake.sceneEvents[0], {
    key: 'moved_outside_gladys',
    data: { device: device.external_id, device_name: device.name, direction: 'up', position: 100 },
  });

  await gladys.fake.setValue(device, feature(device, 'position'), 10);
  await clock.tick(10_000);
  await clock.tick(60_000);
  await gladys.fake.poll(device);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'Gladys moved it');
  assert.ok(COMMAND_WINDOW_MS > 60_000);
});

test('a battery falling under the threshold fires battery_low once', async (t) => {
  const { hub, gladys, device, clock } = await setup(t);
  hub.set(MOTOR, { batteryLevel: 1050 });
  for (let i = 0; i < 2; i += 1) {
    await clock.tick(60_000);
    await gladys.fake.poll(device);
  }
  const events = gladys.fake.sceneEvents.filter((e) => e.key === 'battery_low');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.battery, 11);
});

test('a hub that stops answering: badge, status and scene event', async (t) => {
  const { hub, gladys, device, clock } = await setup(t);
  hub.silent = true;
  await clock.tick(60_000);
  await gladys.fake.poll(device);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(gladys.fake.sceneEvents.at(-1), {
    key: 'hub_connection_changed',
    data: { status: 'lost' },
  });
  hub.silent = false;
  await clock.tick(60_000);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.sceneEvents.at(-1).data.status, 'restored');
});

test('"Test the connection" says what it found, or what is wrong, in every language', async (t) => {
  const { hub, gladys } = await setup(t);
  const ok = await gladys.fake.action('test_connection', {});
  assert.equal(ok.success, true);
  assert.match(ok.data.message.en, /1 motor\(s\).*The key is accepted/);
  assert.deepEqual(Object.keys(ok.data.message).sort(), ['de', 'en', 'es', 'fr']);

  hub.key = 'ffffffff-ffff-ff';
  await gladys.fake.configUpdated({ gateway_ip: '127.0.0.1', key: 'ffffffff-ffff-ff0' });
  const badFormat = await gladys.fake.action('test_connection', {});
  assert.match(badFormat.data.message.en, /exactly 16 characters/);
});

test('"Identify" jogs the motor up, then down', async (t) => {
  const { hub, gladys, device } = await setup(t);
  const ack = await gladys.fake.action('identify', { device: device.external_id });
  assert.equal(ack.success, true);
  const orders = hub.received.filter((r) => r.msgType === 'WriteDevice').map((r) => r.data);
  assert.deepEqual(orders, [{ operation: 7 }, { operation: 8 }]);
});

test('"Find the hub" reads the answers the core relays', async (t) => {
  const { gladys } = await setup(t);
  gladys.fake.scanResults['udp-active-broadcast'] = [
    {
      source_ip: '192.168.1.42',
      source_port: 32100,
      payload_base64: Buffer.from(
        JSON.stringify({
          msgType: 'GetDeviceListAck',
          mac: 'f0f5bd3a1b2c',
          deviceType: '02000002',
          data: [
            { mac: 'f0f5bd3a1b2c', deviceType: '02000002' },
            { mac: 'x1', deviceType: '10000000' },
          ],
        }),
      ).toString('base64'),
    },
  ];
  const ack = await gladys.fake.action('find_gateway', {});
  assert.match(ack.data.message.en, /192\.168\.1\.42 \(f0f5bd3a1b2c, 1 motor\(s\)\)/);
  assert.equal(gladys.fake.scans.at(-1).port, 32100);
});

test('scene actions reach the hub', async (t) => {
  const { hub, gladys, device } = await setup(t);
  const last = () => hub.motors.get(MOTOR).lastOrder;
  await gladys.fake.sceneAction('favorite_position', { device: device.external_id });
  assert.deepEqual(last(), { operation: 12 });
  await gladys.fake.sceneAction('jog', { device: device.external_id, direction: 'down' });
  assert.deepEqual(last(), { operation: 8 });
  await gladys.fake.sceneAction('set_tilt', { device: device.external_id, angle: 90 });
  assert.deepEqual(last(), { targetAngle: 90 });
  const all = await gladys.fake.sceneAction('move_all', { order: 'close' });
  assert.deepEqual(all, { success: true, data: { outputs: { sent: 1, failed: 0 } } });
  assert.deepEqual(last(), { operation: 0 });
});

test('the widget is rendered exactly as sent, and its buttons work', async (t) => {
  const { hub, gladys, device } = await setup(t);
  gladys.fake.devices = [{ ...device, name: 'Salon' }];
  const ack = await gladys.fake.widgetGet('connector', {
    settings: {},
    language: 'fr',
    units: 'metric',
  });
  assert.equal(ack.success, true);
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  const content = ack.data.content;
  assert.equal(content.components[0].device_feature, feature(device, 'position').external_id);
  const toast = await gladys.fake.widgetAction('connector', 'open_all', {}, { settings: {} });
  assert.equal(toast.success, true);
  assert.deepEqual(hub.motors.get(MOTOR).lastOrder, { operation: 1 });
});

test('a top down bottom up blind gets two rails', async (t) => {
  const tdbu = {
    mac: 'f0f5bd3a1b2c0002',
    deviceType: '10000001',
    data: {
      type: 9,
      operation_T: 2,
      operation_B: 2,
      currentPosition_T: 0,
      currentPosition_B: 100,
      voltageMode: 1,
      batteryLevel_T: 1200,
      batteryLevel_B: 1200,
      wirelessMode: 1,
    },
  };
  const { hub, gladys, device } = await setup(t, { motors: [tdbu] });
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['top-state', 'top-position', 'bottom-state', 'bottom-position', 'battery'],
  );
  assert.equal(gladys.fake.lastState(feature(device, 'bottom-position').external_id), 0);
  await gladys.fake.setValue(device, feature(device, 'top-position'), 40);
  assert.deepEqual(hub.motors.get(tdbu.mac).lastOrder, { targetPosition_T: 60 });
});

test('without an IP address, the status says what is missing and nothing is sent', async (t) => {
  const hub = await startFakeHub();
  t.after(() => hub.close());
  const gladys = createFakeGladys({ config: {} });
  const app = registerHandlers(gladys, { clock: manualClock() });
  t.after(() => app.stop());
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /IP address/);
  assert.equal(hub.received.length, 0);
});
