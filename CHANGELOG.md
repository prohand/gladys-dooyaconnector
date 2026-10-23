# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

Describe each change under `## [Unreleased]` as you make it. The Release workflow
moves that section under the version it ships, and the section becomes the notes of
the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

- Maintenance release, no functional change.

## [0.1.1] - 2026-10-16

### Added

- First version of the Dooya Connector integration, started from the official
  JavaScript template: local control of the motors of a Connector hub (UDP port
  32100, no cloud account).
- Roller blinds, shutters, venetian blinds, awnings, gates and curtains: open / stop /
  close, position (when the motor reports it) and battery level (battery motors).
  Top down bottom up blinds get two rails.
- After an order, the motor is followed every 2 seconds until it stops, so the
  position in Gladys follows the movement.
- Transport badge (`local` / `unreachable`) on every motor, and the connection status
  in the Configuration screen.
- Configuration screen actions: "Test the connection", "Find the hub" (broadcast
  through the Gladys core) and "Identify a motor" (one step up, then back down).
- Scene triggers (Gladys 5.1+): a blind moved without Gladys, a motor battery is low,
  the hub connection changed.
- Scene actions (Gladys 5.1+): go to the favourite position, move one step, tilt the
  slats, move every blind.
- "Dooya Connector" dashboard widget: live positions, hub status, low batteries, and
  open / close / stop all.
- English, French, German and Spanish everywhere: configuration, messages, scenes,
  widget and documentation.
- CI (format, lint, tests on Node 22 and 24, store checks and Docker build on pull
  requests), UI-driven Release workflow, GitHub Releases, Dependabot.
- `SECURITY.md` and `CLAUDE.md`.

[Unreleased]: https://github.com/prohand/gladys-dooyaconnector/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/prohand/gladys-dooyaconnector/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/prohand/gladys-dooyaconnector/releases/tag/v0.1.1
