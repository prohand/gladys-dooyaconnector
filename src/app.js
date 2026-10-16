// -----------------------------------------------------------------------------
// The integration: every Gladys handler, wired to the hub.
//
// index.js only builds the SDK client and connects; everything else is here so
// the tests can run it against the fake Gladys of the SDK and a fake hub.
//
// Lifecycle:
//   1. connected → read the config, discover the motors, publish them, report
//      the connection status and the transport badges, start the hub check;
//   2. Gladys polls the created motors (onPoll), the user acts on them
//      (onSetValue), runs actions, scenes and widget buttons;
//   3. config updated → a new client when the address or the key changed, and
//      the same as (1);
//   4. disconnected / shutdown → every timer stopped.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { missingSettings, normalizeConfig } from './config.js';
import { ConnectorClient } from './connector/client.js';
import { findHubs } from './connector/discovery.js';
import { createPoller, Fleet } from './devices/index.js';
import { commandFor } from './devices/motor.js';
import {
  fireSceneEvent,
  HUB_STATUSES,
  SCENE_ACTION_HANDLERS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
} from './capabilities/scenes.js';
import { CONNECTOR_WIDGET, widgetAction, widgetContent } from './capabilities/widget.js';
import { localize, pick } from './i18n.js';

const logger = createLogger({ name: 'app' });

/** How often the hub itself is checked, motors or not. */
export const HUB_CHECK_MS = 60_000;

/**
 * Register every handler on the SDK client.
 * @param {object} gladys a `GladysIntegration` (or the fake one of the SDK)
 * @param {object} [options]
 * @param {(config: object) => ConnectorClient} [options.createClient] tests: a client on a fake hub
 * @param {object} [options.clock] tests: `{ now, setInterval, clearInterval }`
 * @param {(ms: number) => Promise<void>} [options.pause] tests: the identify pause
 * @returns {{ stop: () => void, fleet: Fleet, status: () => object }}
 */
export function registerHandlers(gladys, options = {}) {
  const createClient =
    options.createClient ??
    ((config) => new ConnectorClient({ host: config.gateway_ip, key: config.key }));
  const clock = options.clock ?? {};
  const setTimer = clock.setInterval ?? setInterval;
  const clearTimer = clock.clearInterval ?? clearInterval;

  let config = normalizeConfig();
  let client = null;
  let gateway = null;
  let hubCheck = null;

  const fleet = new Fleet({ gladys, client: () => currentClient(), config: () => config, clock });
  const pollDevice = createPoller(fleet);

  function currentClient() {
    if (!client) {
      client = createClient(config);
      client.on('reachability', (reachable) => {
        onReachability(reachable).catch((err) => logger.error('Reachability update failed', err));
      });
    }
    return client;
  }

  function status() {
    return {
      configured: missingSettings(config).length === 0,
      reachable: client?.reachable ?? null,
      hub: client?.hub ?? null,
      gateway,
    };
  }

  /** The hub stopped answering, or answers again: badge, status, scene event. */
  let wasReachable = null;
  async function onReachability(reachable) {
    const before = wasReachable;
    wasReachable = reachable;
    logger.info(reachable ? 'The hub answers' : 'The hub does not answer');
    await publishTransports(reachable);
    await reportConnection();
    gladys.requestWidgetRefresh(CONNECTOR_WIDGET);
    // The first answer after a start is no transition.
    if (before !== null) {
      await fireSceneEvent(gladys, SCENE_TRIGGERS.HUB_CONNECTION_CHANGED, {
        status: reachable ? HUB_STATUSES.RESTORED : HUB_STATUSES.LOST,
      });
    }
  }

  /** The badge of every created motor: `local` when the hub answers, `unreachable` otherwise. */
  async function publishTransports(reachable) {
    const entries = fleet.transportEntries(reachable);
    if (entries.length === 0) {
      return;
    }
    try {
      await gladys.publishTransports(entries);
    } catch (err) {
      logger.warn(`Transport badges not published: ${err.message}`);
    }
  }

  async function reportConnection() {
    const missing = missingSettings(config);
    if (missing.length > 0) {
      await gladys.setConnectionStatus(false, MESSAGES.notConfigured);
      return;
    }
    if (client?.reachable === false) {
      await gladys.setConnectionStatus(false, MESSAGES.unreachable(config.gateway_ip));
      return;
    }
    await gladys.setConnectionStatus(client?.reachable === true);
  }

  /** Discover and publish the motors; a hub down publishes nothing (the list stays). */
  async function publishDevices() {
    if (missingSettings(config).length > 0) {
      logger.warn('Set the IP address of the hub and its key in the configuration');
      return false;
    }
    try {
      await gladys.publishDiscoveredDevices(await fleet.discover());
      return true;
    } catch (err) {
      logger.error(`Discovery failed: ${err.message}`);
      return false;
    }
  }

  async function checkHub() {
    if (missingSettings(config).length > 0) {
      return;
    }
    try {
      gateway = await currentClient().readGateway();
    } catch (err) {
      logger.debug(`Hub check failed: ${err.message}`);
    }
  }

  async function start() {
    stop();
    await publishDevices();
    await checkHub();
    await publishTransports(client?.reachable === true);
    await reportConnection();
    gladys.requestWidgetRefresh(CONNECTOR_WIDGET);
    hubCheck = setTimer(() => {
      checkHub().catch(() => {});
    }, HUB_CHECK_MS);
  }

  function stop() {
    if (hubCheck) {
      clearTimer(hubCheck);
      hubCheck = null;
    }
    fleet.stop();
  }

  function applyConfig(raw) {
    const next = normalizeConfig(raw);
    if (next.gateway_ip !== config.gateway_ip || next.key !== config.key) {
      // Another hub, or another key: nothing known so far still holds.
      client?.removeAllListeners('reachability');
      client = null;
      gateway = null;
      wasReachable = null;
      fleet.reset();
    }
    config = next;
  }

  // --- Discovery ---------------------------------------------------------------
  gladys.onScanRequest(async () => {
    await publishDevices();
  });

  // --- Commands ------------------------------------------------------------------
  gladys.onSetValue(async (device, feature, value) => {
    const motor = await fleet.motorOf(device.external_id);
    const data = commandFor(gladys, motor, feature.external_id, value);
    if (!data) {
      throw new Error(`${feature.external_id} takes no command`);
    }
    await fleet.command(motor, data);
  });

  // --- Polling -------------------------------------------------------------------
  gladys.onPoll(async (device) => {
    if (!(await pollDevice(device, config))) {
      logger.debug(`Poll skipped (not due) for ${device.external_id}`);
    }
  });

  // A device just created: its states were dropped until now, read it at once,
  // and give it its transport badge.
  gladys.onDeviceCreated(async (device) => {
    if (!fleet.isMotor(device.external_id)) {
      return;
    }
    try {
      await fleet.refresh(await fleet.motorOf(device.external_id));
    } catch (err) {
      logger.debug(`First read of ${device.external_id} failed: ${err.message}`);
    }
    await publishTransports(client?.reachable === true);
  });

  // --- Configuration screen actions ------------------------------------------------
  gladys.onAction('test_connection', async () => testConnection());

  gladys.onAction('find_gateway', async () => {
    const hubs = await findHubs(gladys);
    return MESSAGES.hubsFound(hubs);
  });

  gladys.onAction('identify', async (fields) => {
    const motor = await fleet.motorOf(fields.device);
    await fleet.identify(motor, options.pause);
    return MESSAGES.identified;
  });

  async function testConnection() {
    const missing = missingSettings(config);
    if (missing.length > 0) {
      return MESSAGES.notConfigured;
    }
    try {
      const hub = await currentClient().getDeviceList();
      gateway = await currentClient().readGateway();
      gladys.requestWidgetRefresh(CONNECTOR_WIDGET);
      return MESSAGES.connectionOk(hub, gateway);
    } catch (err) {
      return MESSAGES.connectionFailed(err, config.gateway_ip);
    }
  }

  // --- Scene actions ---------------------------------------------------------------
  for (const key of Object.values(SCENE_ACTIONS)) {
    gladys.onSceneAction(key, (fields) => SCENE_ACTION_HANDLERS[key](fleet, fields));
  }

  // --- Dashboard widget --------------------------------------------------------------
  gladys.onWidgetGet(CONNECTOR_WIDGET, async () => widgetContent({ fleet, status: status() }));
  gladys.onWidgetAction(CONNECTOR_WIDGET, async (actionKey) => widgetAction({ fleet, actionKey }));

  // --- Configuration updated -----------------------------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('New configuration received');
    applyConfig(newConfig);
    await start();
  });

  // --- Connection lifecycle ------------------------------------------------------------
  gladys.on('connected', async () => {
    try {
      applyConfig(await gladys.getConfig());
      await start();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys.setConnectionStatus(false, MESSAGES.initFailed).catch(() => {});
    }
  });

  gladys.on('disconnected', () => stop());

  return { stop, fleet, status };
}

/** Every user-facing message, in every language. */
export const MESSAGES = {
  notConfigured: {
    en: 'Enter the IP address of the hub and the key of the Connector app.',
    fr: "Renseignez l'adresse IP de la passerelle et la clé de l'application Connector.",
    de: 'Gib die IP-Adresse des Gateways und den Schlüssel der Connector-App ein.',
    es: 'Indique la dirección IP de la pasarela y la clave de la app Connector.',
  },
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les journaux de l'intégration.",
    de: 'Die Initialisierung ist fehlgeschlagen, sieh in den Protokollen der Integration nach.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  identified: {
    en: 'The motor moved one step up, then back down.',
    fr: 'Le moteur a fait un petit pas vers le haut, puis vers le bas.',
    de: 'Der Motor ist einen kleinen Schritt hoch und wieder runter gefahren.',
    es: 'El motor ha subido un pequeño paso y luego ha vuelto a bajar.',
  },
  unreachable: (ip) =>
    localize((language) =>
      pick(language, {
        en: `The hub at ${ip} does not answer.`,
        fr: `La passerelle ${ip} ne répond pas.`,
        de: `Das Gateway ${ip} antwortet nicht.`,
        es: `La pasarela ${ip} no responde.`,
      }),
    ),
  connectionOk: (hub, gateway) =>
    localize((language) => {
      const parts = [
        pick(language, {
          en: `Connected to the hub ${hub.mac}`,
          fr: `Connecté à la passerelle ${hub.mac}`,
          de: `Mit dem Gateway ${hub.mac} verbunden`,
          es: `Conectado a la pasarela ${hub.mac}`,
        }),
        pick(language, {
          en: `${hub.motors.length} motor(s)`,
          fr: `${hub.motors.length} moteur(s)`,
          de: `${hub.motors.length} Motor(en)`,
          es: `${hub.motors.length} motor(es)`,
        }),
      ];
      if (hub.firmware) {
        parts.push(`firmware ${hub.firmware}`);
      }
      if (Number.isFinite(gateway?.RSSI)) {
        parts.push(`Wi-Fi ${gateway.RSSI} dBm`);
      }
      return `${parts.join(', ')}. ${pick(language, {
        en: 'The key is accepted.',
        fr: 'La clé est acceptée.',
        de: 'Der Schlüssel wird akzeptiert.',
        es: 'La clave es aceptada.',
      })}`;
    }),
  connectionFailed: (err, ip) =>
    localize((language) => {
      switch (err.code) {
        case 'UNREACHABLE':
          return pick(language, {
            en: `No answer from ${ip} on UDP port 32100. Check the IP address, and that the hub is powered and on the same network as Gladys.`,
            fr: `Aucune réponse de ${ip} sur le port UDP 32100. Vérifiez l'adresse IP, que la passerelle est alimentée et sur le même réseau que Gladys.`,
            de: `Keine Antwort von ${ip} auf UDP-Port 32100. Prüfe die IP-Adresse und ob das Gateway eingeschaltet und im selben Netzwerk wie Gladys ist.`,
            es: `Sin respuesta de ${ip} en el puerto UDP 32100. Compruebe la dirección IP, y que la pasarela está encendida y en la misma red que Gladys.`,
          });
        case 'BAD_KEY_FORMAT':
          return pick(language, {
            en: 'The key must be exactly 16 characters, dashes included, as the Connector app shows it.',
            fr: "La clé doit faire exactement 16 caractères, tirets compris, telle que l'application Connector l'affiche.",
            de: 'Der Schlüssel muss genau 16 Zeichen lang sein, Bindestriche inklusive, so wie die Connector-App ihn anzeigt.',
            es: 'La clave debe tener exactamente 16 caracteres, guiones incluidos, tal como la muestra la app Connector.',
          });
        case 'BAD_KEY':
          return pick(language, {
            en: 'The hub answers but refuses the key. Copy it again from the Connector app.',
            fr: "La passerelle répond mais refuse la clé. Recopiez-la depuis l'application Connector.",
            de: 'Das Gateway antwortet, lehnt aber den Schlüssel ab. Kopiere ihn erneut aus der Connector-App.',
            es: 'La pasarela responde pero rechaza la clave. Cópiela de nuevo desde la app Connector.',
          });
        default:
          return `${pick(language, {
            en: 'The hub answered with an error',
            fr: 'La passerelle a répondu par une erreur',
            de: 'Das Gateway hat mit einem Fehler geantwortet',
            es: 'La pasarela ha respondido con un error',
          })}: ${err.message}`;
      }
    }),
  hubsFound: (hubs) =>
    localize((language) => {
      if (hubs.length === 0) {
        return pick(language, {
          en: 'No hub answered. Read its IP address in the Connector app or in your router, and enter it in the configuration.',
          fr: "Aucune passerelle n'a répondu. Lisez son adresse IP dans l'application Connector ou dans votre box, puis saisissez-la dans la configuration.",
          de: 'Kein Gateway hat geantwortet. Lies seine IP-Adresse in der Connector-App oder in deinem Router ab und trage sie in die Konfiguration ein.',
          es: 'Ninguna pasarela ha respondido. Consulte su dirección IP en la app Connector o en su router, e introdúzcala en la configuración.',
        });
      }
      const list = hubs
        .map(
          (hub) =>
            `${hub.ip} (${hub.mac}, ${pick(language, {
              en: `${hub.motors} motor(s)`,
              fr: `${hub.motors} moteur(s)`,
              de: `${hub.motors} Motor(en)`,
              es: `${hub.motors} motor(es)`,
            })})`,
        )
        .join(', ');
      return `${pick(language, {
        en: 'Found',
        fr: 'Trouvé',
        de: 'Gefunden',
        es: 'Encontrado',
      })}: ${list}. ${pick(language, {
        en: 'Copy the IP address into the configuration.',
        fr: "Copiez l'adresse IP dans la configuration.",
        de: 'Übernimm die IP-Adresse in die Konfiguration.',
        es: 'Copie la dirección IP en la configuración.',
      })}`;
    }),
};
