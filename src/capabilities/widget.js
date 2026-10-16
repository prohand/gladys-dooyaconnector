// -----------------------------------------------------------------------------
// The "Dooya Connector" dashboard widget (Gladys 5.1+).
//
//   - up to four live tiles: the position of the first motors created in
//     Gladys (device-bound: they follow the published states, no refresh);
//   - a status list: hub reachable or not, motors, Wi-Fi signal, firmware,
//     batteries under the threshold;
//   - three buttons: open, close (confirmed) and stop every motor.
//
// The content budget of the core is 8 components: 4 tiles + 1 status + 3
// buttons fills it exactly, so a tile is never dropped in favour of a button.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { OPERATIONS } from '../connector/protocol.js';
import { FEATURES } from '../devices/motor.js';
import { localize, pick } from '../i18n.js';

const logger = createLogger({ name: 'widget' });

/** Widget key, as declared in the manifest `widgets` field. Never rename it. */
export const CONNECTOR_WIDGET = 'connector';

/** Keys of the `button` actions of the content. */
export const WIDGET_ACTIONS = {
  OPEN_ALL: 'open_all',
  CLOSE_ALL: 'close_all',
  STOP_ALL: 'stop_all',
};

const ACTION_OPERATIONS = {
  [WIDGET_ACTIONS.OPEN_ALL]: OPERATIONS.OPEN,
  [WIDGET_ACTIONS.CLOSE_ALL]: OPERATIONS.CLOSE,
  [WIDGET_ACTIONS.STOP_ALL]: OPERATIONS.STOP,
};

const MAX_TILES = 4;
const TILE_LABEL_LENGTH = 24;
const STATUS_VALUE_LENGTH = 40;

const TEXTS = {
  hub: { en: 'Hub', fr: 'Passerelle', de: 'Gateway', es: 'Pasarela' },
  connected: { en: 'Connected', fr: 'Connectée', de: 'Verbunden', es: 'Conectada' },
  unreachable: { en: 'Unreachable', fr: 'Injoignable', de: 'Nicht erreichbar', es: 'Inaccesible' },
  waiting: {
    en: 'Not checked yet',
    fr: 'Pas encore vérifiée',
    de: 'Noch nicht geprüft',
    es: 'Aún sin comprobar',
  },
  notConfigured: {
    en: 'IP address or key missing',
    fr: 'Adresse IP ou clé manquante',
    de: 'IP-Adresse oder Schlüssel fehlt',
    es: 'Falta la dirección IP o la clave',
  },
  motors: { en: 'Motors', fr: 'Moteurs', de: 'Motoren', es: 'Motores' },
  signal: { en: 'Wi-Fi signal', fr: 'Signal Wi-Fi', de: 'WLAN-Signal', es: 'Señal Wi-Fi' },
  firmware: { en: 'Firmware', fr: 'Firmware', de: 'Firmware', es: 'Firmware' },
  battery: { en: 'Low battery', fr: 'Batterie faible', de: 'Akku schwach', es: 'Batería baja' },
  none: { en: 'None', fr: 'Aucune', de: 'Keine', es: 'Ninguna' },
  openAll: { en: 'Open all', fr: 'Tout ouvrir', de: 'Alle öffnen', es: 'Abrir todo' },
  closeAll: { en: 'Close all', fr: 'Tout fermer', de: 'Alle schließen', es: 'Cerrar todo' },
  stopAll: { en: 'Stop all', fr: 'Tout arrêter', de: 'Alle stoppen', es: 'Parar todo' },
};

function truncate(text, length) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/** The position feature shown for a created device (the bottom rail of a dual blind). */
function positionFeatureOf(device) {
  const features = device.features ?? [];
  return (
    features.find((feature) => feature.external_id.endsWith(`:${FEATURES.POSITION}`)) ??
    features.find((feature) => feature.external_id.endsWith(`:${FEATURES.BOTTOM_POSITION}`))
  );
}

function hubStatus({ configured, reachable }) {
  if (!configured) {
    return { value: TEXTS.notConfigured, color: WIDGET_COLORS.WARNING };
  }
  if (reachable === true) {
    return { value: TEXTS.connected, color: WIDGET_COLORS.SUCCESS };
  }
  if (reachable === false) {
    return { value: TEXTS.unreachable, color: WIDGET_COLORS.DANGER };
  }
  return { value: TEXTS.waiting, color: WIDGET_COLORS.NEUTRAL };
}

/**
 * The widget content.
 * @param {object} context
 * @param {import('../devices/index.js').Fleet} context.fleet
 * @param {{ configured: boolean, reachable: boolean|null, hub: object|null, gateway: object|null }} context.status
 */
export function widgetContent({ fleet, status }) {
  const components = [];

  for (const device of fleet.createdDevices()) {
    const feature = positionFeatureOf(device);
    if (!feature) {
      continue;
    }
    components.push({
      type: 'value',
      label: truncate(device.name ?? '', TILE_LABEL_LENGTH),
      icon: 'align-justify',
      device_feature: feature.external_id,
    });
    if (components.length === MAX_TILES) {
      break;
    }
  }

  const items = [{ label: TEXTS.hub, icon: 'wifi', ...hubStatus(status) }];
  const motors = status.hub?.motors?.length ?? fleet.motors.size;
  items.push({ label: TEXTS.motors, icon: 'layers', value: motors, color: WIDGET_COLORS.NEUTRAL });
  if (Number.isFinite(status.gateway?.RSSI)) {
    items.push({
      label: TEXTS.signal,
      icon: 'bar-chart-2',
      value: `${status.gateway.RSSI} dBm`,
      color: status.gateway.RSSI > -75 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
    });
  }
  if (status.hub?.firmware) {
    items.push({
      label: TEXTS.firmware,
      icon: 'cpu',
      value: truncate(String(status.hub.firmware), STATUS_VALUE_LENGTH),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  const low = fleet.lowBatteries().map((motor) => fleet.nameOf(motor));
  items.push({
    label: TEXTS.battery,
    icon: 'battery',
    value: low.length > 0 ? truncate(low.join(', '), STATUS_VALUE_LENGTH) : TEXTS.none,
    color: low.length > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  });
  components.push({ type: 'status', items });

  if (status.configured) {
    components.push(
      {
        type: 'button',
        label: TEXTS.openAll,
        icon: 'arrow-up',
        style: 'primary',
        action: { key: WIDGET_ACTIONS.OPEN_ALL },
      },
      {
        type: 'button',
        label: TEXTS.closeAll,
        icon: 'arrow-down',
        style: 'secondary',
        // A dashboard can hang on a wall: closing the whole house asks first.
        action: { key: WIDGET_ACTIONS.CLOSE_ALL, confirm: true },
      },
      {
        type: 'button',
        label: TEXTS.stopAll,
        icon: 'pause',
        style: 'secondary',
        action: { key: WIDGET_ACTIONS.STOP_ALL },
      },
    );
  }

  return {
    // The live tiles need no refresh; the status list is nudged on every
    // change the integration sees (see app.js): the TTL is a safety net.
    ttl_seconds: 300,
    components,
  };
}

/**
 * A tapped button: the same order to every motor, and a short toast.
 */
export async function widgetAction({ fleet, actionKey }) {
  logger.info(`Widget action ${actionKey}`);
  const operation = ACTION_OPERATIONS[actionKey];
  if (operation === undefined) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  const { sent, failed } = await fleet.commandAll(operation);
  return localize((language) => {
    const done = pick(language, {
      en: `${sent} motor(s) reached`,
      fr: `${sent} moteur(s) atteint(s)`,
      de: `${sent} Motor(en) erreicht`,
      es: `${sent} motor(es) alcanzado(s)`,
    });
    if (failed === 0) {
      return done;
    }
    return `${done}, ${pick(language, {
      en: `${failed} did not answer`,
      fr: `${failed} sans réponse`,
      de: `${failed} ohne Antwort`,
      es: `${failed} sin respuesta`,
    })}`;
  });
}
