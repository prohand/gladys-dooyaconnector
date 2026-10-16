// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` of
// `gladys-assistant-integration.json`. This module only provides the defaults
// and normalizes what Gladys sends, so the rest of the code never deals with
// `undefined`, a number typed as a string or a key pasted with spaces.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  // IPv4 address of the Connector hub on the LAN. No default: the container
  // runs on a bridge network, where the hub's multicast announcements never
  // arrive, so the hub is reached in unicast at the address the user gives.
  gateway_ip: '',
  // The 16-character key shown by the Connector app (About screen, tap five
  // times). Never logged.
  key: '',
  // Seconds between two reads of a motor's state. Gladys polls at most twice
  // a minute here (see src/devices/index.js): slower intervals skip polls.
  poll_frequency: 60,
  // Battery percentage under which the `battery_low` scene trigger fires.
  battery_low_threshold: 20,
};

export const POLL_FREQUENCY_BOUNDS = { min: 30, max: 3600 };
export const BATTERY_THRESHOLD_BOUNDS = { min: 5, max: 50 };

function bounded(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    gateway_ip: String(raw.gateway_ip ?? '').trim(),
    // The app shows the key with its dashes ("12ab345c-d67e-8f"): they are part
    // of the 16 characters, only the spaces around a paste are not.
    key: String(raw.key ?? '').trim(),
    poll_frequency: bounded(
      raw.poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      POLL_FREQUENCY_BOUNDS,
    ),
    battery_low_threshold: bounded(
      raw.battery_low_threshold,
      DEFAULT_CONFIG.battery_low_threshold,
      BATTERY_THRESHOLD_BOUNDS,
    ),
  };
}

/** What is still missing before the hub can be reached, as config keys. */
export function missingSettings(config) {
  return ['gateway_ip', 'key'].filter((key) => !config[key]);
}
