# Dooya Connector — Gladys Assistant integration

External integration for [Gladys Assistant](https://gladysassistant.com) that drives the
blind, shutter and curtain motors of a **Dooya Connector** hub (DD7002B and alike, also
sold as Brel, Bloc Blinds, Coulisse Motion, Smart Blinds…), **locally**.

Built from the official template
[`GladysAssistant/integration-template-js`](https://github.com/GladysAssistant/integration-template-js)
with the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [English](docs/en.md) · [Français](docs/fr.md) ·
[Deutsch](docs/de.md) · [Español](docs/es.md)

## What it does

| Surface                 | What                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Devices                 | One device per motor: open / stop / close, position, battery. Curtains get the `curtain` category. |
| Transport (`local`)     | Badge `local` / `unreachable` per motor, connection status in the Configuration screen.            |
| Actions                 | Test the connection, Find the hub (broadcast through the Gladys core), Identify a motor.           |
| Scene triggers (5.1+)   | `moved_outside_gladys`, `battery_low`, `hub_connection_changed`.                                   |
| Scene actions (5.1+)    | `favorite_position`, `jog`, `set_tilt`, `move_all`.                                                |
| Dashboard widget (5.1+) | `connector`: live positions, hub status, low batteries, open / close / stop all.                   |
| Languages               | English, French, German and Spanish, everywhere.                                                   |

**Local only** (manifest `"transports": ["local"]`): the hub has a documented LAN
protocol, so no cloud account is involved and nothing leaves the home network.

## How it talks to the hub

- JSON over UDP, to port **32100** of the hub, in unicast: the integration container
  runs on a bridge network, where unicast crosses the NAT both ways.
- Orders (`WriteDevice`) carry an `AccessToken`: the hub token (from
  `GetDeviceList`) encrypted with AES-128-ECB under the 16-character key of the
  Connector app.
- The hub's multicast reports (238.0.0.18:32101) never reach the container. States are
  therefore read from the hub's memory (`ReadDevice`, no radio traffic) at the
  configured interval, and every 2 s while a motor runs after an order.
- The hub is found through the Gladys core: manifest `network_discovery`
  `udp-active-broadcast` on port 32100, the integration forges the request and parses
  the answers.

Protocol reference: the open-source
[motion-blinds](https://github.com/starkillerOG/motion-blinds) library used by Home
Assistant.

## Project structure

```
.
├─ index.js                          # SDK bootstrap: registerHandlers, shutdown, connect
├─ src/
│  ├─ app.js                         # every Gladys handler, wired to the hub
│  ├─ config.js                      # defaults + normalization (mirrors the manifest)
│  ├─ i18n.js                        # en, fr, de, es
│  ├─ connector/
│  │  ├─ protocol.js                 # constants, access token, position/battery conversions
│  │  ├─ client.js                   # unicast UDP client: queue, retries, token renewal
│  │  └─ discovery.js                # "Find the hub" through the Gladys core
│  ├─ devices/
│  │  ├─ motor.js                    # one motor = one Gladys device
│  │  └─ index.js                    # Fleet: discovery, polling, tracking, scene events
│  └─ capabilities/
│     ├─ scenes.js                   # scene triggers + scene actions (Gladys 5.1+)
│     └─ widget.js                   # dashboard widget (Gladys 5.1+)
├─ docs/{en,fr,de,es}.md             # user documentation, re-hosted by Gladys
├─ test/                             # node --test, fake Gladys (SDK) + fake UDP hub
├─ gladys-assistant-integration.json # manifest
├─ Dockerfile                        # Node 24 Alpine, non-root, read-only rootfs ready
├─ CHANGELOG.md                      # Keep a Changelog, rolled by the Release workflow
├─ CLAUDE.md                         # project rules for coding assistants & contributors
├─ SECURITY.md                       # how to report a vulnerability privately
├─ .github/workflows/ci.yml          # format, lint, tests (Node 22 + 24), store checks, Docker build
├─ .github/workflows/release.yml     # UI-driven release: bump + changelog + tag + build
├─ .github/workflows/build.yml       # multi-arch build (tag, manual run, or called by release)
├─ .github/workflows/github-release.yml # GitHub Release of every version tag
├─ .github/scripts/changelog-release.mjs # rolls CHANGELOG.md
├─ .github/dependabot.yml            # npm weekly, Actions and Docker monthly
└─ cover.png                         # catalog cover, 800×534 px
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="dooya-connector" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its container; the SDK reads them.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test: fake Gladys of the SDK + a fake hub on 127.0.0.1
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI runs the first three on Node 22 and 24 for every push and pull request; pull
requests also run the store checks and build the Docker image.

## Release

1. Describe the changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major` (pick
   `major` for the first release: 0.1.0 → 1.0.0).
3. The workflow bumps `package.json` and the manifest (`version` + `docker_image`),
   rolls the changelog, tags `vX.Y.Z`, builds the `linux/amd64` + `linux/arm64` image
   to `ghcr.io/prohand/gladys-dooyaconnector` and publishes the GitHub Release.

Before the first release: add the GitHub topic `gladys-assistant-integration` to the
repository, make the `ghcr.io` package public, and turn on **Private vulnerability
reporting** (see [`SECURITY.md`](SECURITY.md)).

## Credits

- Gladys Assistant and its integration template and SDK.
- [starkillerOG/motion-blinds](https://github.com/starkillerOG/motion-blinds) for the
  documentation of the Connector LAN protocol.

## License

Apache-2.0
