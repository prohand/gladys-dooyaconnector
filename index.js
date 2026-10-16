// -----------------------------------------------------------------------------
// Entry point of the Dooya Connector integration for Gladys Assistant.
//
// SDK wiring only: the handlers live in src/app.js (registered BEFORE
// connect()), the hub protocol in src/connector/, the devices in src/devices/.
//
// Environment variables provided by the Gladys supervisor to the container,
// read by the SDK itself:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const app = registerHandlers(gladys);

// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT): stop the timers first.
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  app.stop();
});

logger.info('Starting the Dooya Connector integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
