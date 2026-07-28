# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Matter area IDs are now derived from the Ecovacs area rather than discovery order.** Room details arrive as separate pushes, so their order varies between runs — observed live, where the same controller area meant two different rooms across restarts. Selections made in a controller (including saved automations and scenes) now keep pointing at the room they were made for.
- `ServiceArea.currentArea` reflects where the robot actually is rather than where it was sent, so a controller can distinguish travelling to a room from cleaning it. It is driven by the robot's reported position, with a 90-second fallback that assumes arrival for models that never report one.

- **Room cleans now show as cleaning rather than "travelling to room".** The plugin never wrote `ServiceArea.currentArea`, so it kept Matterbridge's default while the controller had selected a different room; Apple Home compares the two and reports the robot as still on its way. The serviced area is now announced when a room clean starts, tracked from the robot's own reports, and cleared when it stops cleaning.
- The library's internal error codes (negative, e.g. `-2 "Unhandled error"`) are no longer reported as device faults. They put the Matter endpoint into `Error`, which controllers show as an alert on an otherwise healthy vacuum mid-clean.

- The run mode the controller asked for is reported back while cleaning. Apple Home requests `SpotCleaning` when rooms are selected; answering `Cleaning` made it treat the request as not having taken effect, so the vacuum never showed as cleaning.
- Command sequences that wait for a settle interval now run in the background. Matterbridge applies its own cluster state only after the handler resolves, so awaiting in the handler delayed the command response by the settle time and let our state write land before Matterbridge's — the two then fought over the attribute.

- **A vacuum-only clean no longer triggers a mop-pad wash, and "return to dock" actually docks the robot.** Ecovacs commands are applied asynchronously, so a clean sent immediately after `setWorkMode` ran under the _previous_ work mode, and a `charge` sent immediately after a stop was dropped — leaving the robot stopped mid-floor. Dependent commands now wait for the previous one to settle.
- Station activity (`washing`, `drying`, `airdrying`) no longer changes the reported state. A mop-pad wash runs both before and after a job and is reported every second for minutes, so treating it as a state change made a freshly started clean flip to Charging for the length of the wash — which controllers showed as stuck "preparing".
- `batChargeState` follows the dock's own report again rather than the resolved operational state, which made it flap between charging and not-charging while a job started.

- **Fixed commands failing in the controller ("could not complete").** Command handlers wrote Matter attributes synchronously, which deadlocked against the writes Matterbridge's own RVC cluster servers make inside the same command transaction (`[synchronous-transaction-conflict]`). State updates from a command are now deferred until the transaction has completed.
- `pause` and `resume` now use `clean_V2` on V2-generation firmware. The library's `pause()`/`resume()` send the non-V2 `clean` act, which the X2 ignores — the same trap already found with `stop`, so pausing from the controller had no effect on the robot.

- Operational state is now resolved in one place from two independent inputs (the cleaning task and the dock) instead of cross-guards spread across both event handlers, so the precedence rule is explicit: the cleaning side wins while the robot is off the dock, otherwise the dock's view wins. `batChargeState` derives from the resolved state, so a dock reporting `charging` while the robot is away cleaning no longer claims the battery is charging. (Design borrowed from bubez81/matterbridge-ecovacs.)
- Clean state is polled again on the X2 family using `getCleanInfo_V2`, which the firmware accepts — only the classic `getCleanInfo` is rejected with 20003. Previously the plugin relied solely on pushed events, so a dropped MQTT message left the state stale. Model definitions declare `cleanStatePoll` (replaces `cleanStateIsPushOnly`).
- Reconnect now backs off `5s → 15s → 30s → 60s → 120s` instead of retrying flatly every 30s, and resets after a successful connect.

- `goHome` and RunMode Idle now end the job with the V2 stop (`clean_V2` act=stop) before docking. The library's non-V2 `stop()` is ignored by V2 firmware, so jobs interrupted by "send home" stayed "paused" in the Ecovacs app forever (verified live on the X2).
- Cleaning type (Vacuum / Mop / Vacuum & Mop / Mop after Vacuum) is now selected with `setWorkMode`, pinned before every clean. Verified live on an X2 Omni: the previously used `setSweepMode` is a scrubbing-style toggle, not the vacuum/mop selector — a "vacuum-only" clean could mop the floor if the Ecovacs app had left mopping enabled, and merely sending `setSweepMode` triggered a mop-pad wash at the station. Model definitions now declare `cleanTypeStrategy: 'workMode' | 'none'` (replaces `supportsMopping`/`skipSweepModeOnVacuumOnly`).

### Added

- Recognise the CleanReport values a run started from the Ecovacs app reports — `entrust` (AI clean), `qcClean`, `singlePoint`, `move`, `comeClean`, `area`, plus `goCharging`/`slot_charging`. Previously an app-initiated clean showed as Docked in the controller while the robot was out working.

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
