// -----------------------------------------------------------------------------
// Finding the hub on the LAN.
//
// The integration container sits on a bridge network: a broadcast it emits
// never reaches the LAN, and the hub's multicast announcements never reach it.
// The Gladys core, on the host network, broadcasts the request for us (manifest
// `network_discovery`, type `udp-active-broadcast` on port 32100) and relays
// the unicast answers: the integration forges the `GetDeviceList` request and
// reads the answers, the core only carries them.
//
// Best effort: a hub that only listens to its multicast group stays silent to
// a broadcast. The IP address read in the Connector app, or in the DHCP leases
// of the router, always works.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isGateway, messageId, MOTOR_DEVICE_TYPES, normalizeMac, UDP_PORT } from './protocol.js';

const logger = createLogger({ name: 'discovery' });

const SCAN_TIMEOUT_SECONDS = 5;

/** The request every hub answers with its device list. */
export function discoveryPayload(date = new Date()) {
  return Buffer.from(JSON.stringify({ msgType: 'GetDeviceList', msgID: messageId(date) }));
}

/**
 * Ask the core to broadcast a discovery request, and read the hubs out of the
 * answers.
 * @returns {Promise<{ ip: string, mac: string, deviceType: string, firmware: string|null, motors: number }[]>}
 */
export async function findHubs(gladys) {
  const replies = await gladys.scanNetwork('udp-active-broadcast', {
    port: UDP_PORT,
    payload: discoveryPayload(),
    timeoutSeconds: SCAN_TIMEOUT_SECONDS,
  });
  return parseReplies(replies);
}

/** Raw `udp-active-broadcast` results → one entry per hub, in IP order. */
export function parseReplies(replies) {
  const hubs = new Map();
  for (const { source_ip: ip, payload_base64: payload } of replies ?? []) {
    let answer;
    try {
      answer = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (answer?.msgType !== 'GetDeviceListAck') {
      continue;
    }
    const deviceType = String(answer.deviceType ?? '');
    const directMotor = Object.values(MOTOR_DEVICE_TYPES).includes(deviceType);
    if (!isGateway(deviceType) && !directMotor) {
      logger.debug(`Ignored an answer from ${ip}: unknown device type ${deviceType}`);
      continue;
    }
    const motors = (answer.data ?? []).filter((entry) => !isGateway(entry.deviceType)).length;
    hubs.set(ip, {
      ip,
      mac: normalizeMac(answer.mac),
      deviceType,
      firmware: answer.fwVersion ?? null,
      motors,
    });
  }
  return [...hubs.values()].sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
}
