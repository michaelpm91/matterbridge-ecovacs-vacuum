# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `goHome` and RunMode Idle now end the job with the V2 stop (`clean_V2` act=stop) before docking. The library's non-V2 `stop()` is ignored by V2 firmware, so jobs interrupted by "send home" stayed "paused" in the Ecovacs app forever (verified live on the X2).
- Cleaning type (Vacuum / Mop / Vacuum & Mop / Mop after Vacuum) is now selected with `setWorkMode`, pinned before every clean. Verified live on an X2 Omni: the previously used `setSweepMode` is a scrubbing-style toggle, not the vacuum/mop selector — a "vacuum-only" clean could mop the floor if the Ecovacs app had left mopping enabled, and merely sending `setSweepMode` triggered a mop-pad wash at the station. Model definitions now declare `cleanTypeStrategy: 'workMode' | 'none'` (replaces `supportsMopping`/`skipSweepModeOnVacuumOnly`).

### Added

- Configurable, persisted Ecovacs client **device ID** (`deviceId` config field). The plugin logs the ID it uses on every start, persists a generated one so restarts/hostname changes cannot silently invalidate Ecovacs device verification, and prefers an explicit config value. Error 1013 now logs the exact verification command to run.
- `matterbridge-ecovacs-verify` CLI (`bin`) — the device verification is now part of the published package instead of a repo-only script, and takes `--device-id ID` so verification can be performed from any machine on behalf of the Matterbridge host (e.g. a Home Assistant VM).
- Ecovacs session caching: the access token is persisted in the plugin storage and reused across Matterbridge restarts (~6.5-day trust window, validated against the API on start, invalidated when the account, country, or hostname changes). Avoids a fresh login every restart — Ecovacs re-triggers device verification (error 1013) when it sees too many logins from one device ID.
- `scripts/verify-device.mjs` — one-time Ecovacs device verification (login error 1013). Since ~2026-07-14 Ecovacs requires each API client device ID to complete an email verification once; this ports the flow from DeebotUniverse/client.py PR #1706.
- Work-mode and sweep-mode commands in the interactive test console (`wm`, `wm0`–`wm3`, `sm0`, `sm1`) and a `--device N` selector in both debug scripts.

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
