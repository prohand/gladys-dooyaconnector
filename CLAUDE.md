# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and to human contributors
when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) for the **Dooya Connector** hub
(DD7002B and alike, also sold as Brel, Bloc Blinds, Coulisse Motion…) and the blind,
shutter and curtain motors it drives. It started from the official JavaScript template
(GladysAssistant/integration-template-js). It requires Gladys 5.3.0+ (manifest
`keywords`); scene triggers, scene actions and a "Dooya Connector" widget came with 5.1.

**Local only**: the hub is reached in unicast UDP on port 32100 (manifest
`transports: ["local"]`). No cloud account, no cloud API.

## Commands

```bash
npm install
npm test                                    # node --test (built-in runner)
node --test test/client.test.js             # one file
node --test --test-name-pattern "battery"   # tests whose name matches
npm run lint                                # eslint .
npm run format:check                        # prettier --check . (CI gate)
npm run format                              # prettier --write .
npx github:GladysAssistant/integration-store .   # store admission checks
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on Node 22 and
24; pull requests also run the store checks and build the Docker image. Run the three
commands before pushing.

## Architecture

```
index.js                     SDK bootstrap only: registerHandlers, shutdown, connect
src/app.js                   every Gladys handler, wired to the hub (testable)
src/config.js                DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                  LANGUAGES (en, fr, de, es), pick, localize
src/connector/protocol.js    protocol constants, access token (AES-128-ECB), conversions
src/connector/client.js      unicast UDP client: queue, retries, token renewal, reachability
src/connector/discovery.js   "Find the hub": udp-active-broadcast through the Gladys core
src/devices/motor.js         one motor = one Gladys device: features, states, commands
src/devices/index.js         Fleet: discovery, polling, tracking after an order, scene events
src/capabilities/scenes.js   scene triggers and scene actions (Gladys 5.1)
src/capabilities/widget.js   the "connector" dashboard widget (Gladys 5.1)
gladys-assistant-integration.json  manifest
docs/{en,fr,de,es}.md        user documentation, re-hosted by Gladys
test/                        node --test, fake Gladys of the SDK + fake UDP hub
.github/scripts/changelog-release.mjs  rolls CHANGELOG.md at release time
```

### Invariants worth knowing

- **Bridge network.** The container never receives the hub's multicast reports
  (238.0.0.18:32101) nor emits a broadcast to the LAN. States therefore come from
  `ReadDevice` (the hub answers from its cache, no radio traffic) at the configured
  interval, and every 2 s while a motor runs after an order. Discovery of the hub goes
  through `gladys.scanNetwork('udp-active-broadcast', { port: 32100 })`.
- **Positions are inverted.** The hub counts 0 = open, 100 = closed; Gladys 100 = open.
  Always go through `toGladysPosition` / `toHubPosition`.
- **Access token** = AES-128-ECB(token, key), uppercase hex, no padding. The token
  changes when the hub restarts: the client renews it once on a refusal.
- **One request at a time.** The client queues them; an unanswered request is sent
  three times before the hub is called unreachable.
- **Polling**: devices are published with `should_poll: true` and
  `poll_frequency: EVERY_30_SECONDS` (Gladys refuses any value outside
  `DEVICE_POLL_FREQUENCIES`, in ms). The configured `poll_frequency` is in seconds and
  applied by skipping polls (`createPoller`). Since Gladys 5.3 the core sets
  `should_poll` itself from `poll_frequency`; the flag stays for older devices.
- **Scene events, one per transition.** `moved_outside_gladys` is never fired within
  `COMMAND_WINDOW_MS` of a Gladys order (no loop through a scene); `battery_low` has a
  hysteresis; `hub_connection_changed` skips the first answer after a start.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys).

## Rules

- **External ids are forever.** Devices are `gladys.externalIds('motor', mac)`; feature
  keys (`state`, `position`, `battery`, `top-*`, `bottom-*`), config keys, action,
  scene trigger, scene action and widget keys are stored by users: never rename them.
- **Secrets.** Never log the key, the hub token or the access token (`redact`).
- **The container rootfs is read-only.** Write only under `/data` (nothing is written
  today).
- **Versions belong to the Release workflow** (Actions → Release). Never edit `version`
  in `package.json` or the manifest, nor the `docker_image` tag, by hand.
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`). Never write
  a version heading: the Release workflow does.
- **Manifest.** Every text is `{ en, fr, de, es }` (labels, descriptions, placeholders,
  options). The catalog `description` holds 10 to 100 characters per language.
  `gladys_version` is `>=5.3.0` (`keywords`); `keywords` are 1-10 unique search terms
  of 2-30 characters (brands the hub is sold as), no `countries` (sold worldwide).
  `test/manifest.test.js` ties the manifest to the code: change both sides together.
- **User-facing text** is in four languages: messages built with `src/i18n.js`, and
  `docs/en.md`, `docs/fr.md`, `docs/de.md`, `docs/es.md` kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why, in
  English. Tests never touch the network beyond the loopback fake hub.
