# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-25

First public release, formalised from the `matterbridge-deebot-x2` prototype.

### Added

- Matter RVC bridging for Ecovacs robot vacuums via Matterbridge (start/stop/pause/resume/go home, clean modes, suction speeds, battery, charging state, error reporting).
- Room (spot area) cleaning driven by the robot's saved map, exposed through the Matter ServiceArea cluster.
- Declarative per-model capability registry (`src/models/models.ts`) keyed by Ecovacs device class, with a conservative default profile for unknown models.
- Deebot X2 family profile (`e6ofmn` + aliases): `Clean_V2`, `freeClean` room cleans, push-only clean state, mop control with the vacuum-only sweep-mode quirk handled.
- Support for multiple robots on one Ecovacs account.
- Automatic reconnect after MQTT connection loss.
- Interactive command console (`scripts/test-commands.mjs`) with TX/RX tracing that surfaces silently rejected commands, for validating new model entries.
- Connectivity debug script (`scripts/debug-ecovacs.mjs`).
