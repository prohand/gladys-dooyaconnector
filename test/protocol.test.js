import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessToken,
  batteryPercent,
  ConnectorError,
  isCurtain,
  maxAngle,
  messageId,
  normalizeMac,
  redact,
  reportsPosition,
  toGladysPosition,
  toHubPosition,
} from '../src/connector/protocol.js';

test('the access token is the token encrypted with the key, AES-128-ECB, uppercase hex', () => {
  // Reference computed with `openssl enc -aes-128-ecb -nopad`.
  assert.equal(
    accessToken('AbCdEfGh12345678', '12ab345c-d67e-8f'),
    '547EA41B69A66ABCD7CCD8E6511164B3',
  );
});

test('a key that is not 16 characters is refused before anything is sent', () => {
  assert.throws(
    () => accessToken('AbCdEfGh12345678', '12ab345c'),
    (err) => err instanceof ConnectorError && err.code === 'BAD_KEY_FORMAT',
  );
});

test('the message id is the UTC time to the millisecond, as 17 digits', () => {
  assert.equal(messageId(new Date('2026-10-16T08:09:10.123Z')), '20261016080910123');
});

test('positions are turned around: the hub counts from the top, Gladys from the bottom', () => {
  assert.equal(toGladysPosition(0), 100);
  assert.equal(toGladysPosition(100), 0);
  assert.equal(toGladysPosition(30), 70);
  assert.equal(toHubPosition(70), 30);
  assert.equal(toHubPosition(150), 0, 'clamped');
  assert.equal(toGladysPosition('abc'), null);
});

test('the battery percentage follows the pack the voltage reveals', () => {
  assert.equal(batteryPercent(1234), 100, '3 cells, full');
  assert.equal(batteryPercent(1027), 0, '3 cells, empty');
  assert.equal(batteryPercent(840), 100, '2 cells, full');
  assert.equal(batteryPercent(1570), 50, '4 cells, half');
  assert.equal(batteryPercent(23000), null, 'mains motor');
});

test('curtains, position reporting and slat angles follow the motor type', () => {
  assert.ok(isCurtain('10000000', 12));
  assert.ok(isCurtain('22000000'));
  assert.ok(!isCurtain('10000000', 1));
  assert.ok(!reportsPosition(0), 'one-way radio');
  assert.ok(!reportsPosition(2), 'limits only');
  assert.ok(reportsPosition(1));
  assert.equal(maxAngle('10000002'), 90);
  assert.equal(maxAngle('10000000', 5), 90);
  assert.equal(maxAngle('10000000', 2), 180);
});

test('macs are lowercase hexadecimal, usable in an external id', () => {
  assert.equal(normalizeMac('F0:F5:BD:3A:1B:2C-0001'), 'f0f5bd3a1b2c0001');
});

test('logged messages never carry the token or the access token', () => {
  const safe = redact({ msgType: 'WriteDevice', AccessToken: 'SECRET', token: 'SECRET' });
  assert.ok(!JSON.stringify(safe).includes('SECRET'));
  assert.equal(safe.msgType, 'WriteDevice');
});
