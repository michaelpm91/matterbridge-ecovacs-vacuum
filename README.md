# matterbridge-ecovacs

[Matterbridge](https://github.com/Luligu/matterbridge) plugin that exposes Ecovacs robot vacuums (Deebot, yeedi) as Matter **Robotic Vacuum Cleaner** devices — so you can control them from Apple Home (HomeKit), Alexa, Google Home, or SmartThings.

## Features

- **Start / stop / pause / resume / send home** from your Matter controller
- **Room (spot area) cleaning** — rooms from the robot's saved map appear in the Apple Home room picker
- **Clean modes** — Vacuum, Mop, Vacuum & Mop, Mop after Vacuum (model dependent)
- **Suction speed** — Quiet / Automatic / Quick / Deep Clean via the Apple Home speed picker
- **Battery level and charging state**, including full-charge detection
- **Error reporting** mapped to Matter RVC operational errors (dust bin, water tanks, stuck, …)
- **Automatic reconnect** when the Ecovacs cloud connection drops
- Bridges **every robot on your Ecovacs account**

## Supported models

| Model                                        | Device class         | Status                                                                                                         |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Deebot X2 / X2 Omni / X2 Combo / X2 Pro Omni | `e6ofmn` (+ aliases) | ✅ Verified on X2 Omni                                                                                         |
| Other Deebot / yeedi models                  | any                  | ⚠️ Default profile: basic vacuum control (start/stop/dock, speeds); no mop control or room cleaning guarantees |

Robots with an unrecognised device class fall back to a conservative 950-type profile and log a warning. If that's your robot, please [open an issue](https://github.com/michaelpm91/matterbridge-ecovacs/issues) with the logged device class — adding a model is usually a small, declarative change (see below).

## Installation

Install via the Matterbridge frontend (search for `matterbridge-ecovacs`), or manually:

```bash
npm install -g matterbridge-ecovacs
matterbridge -add matterbridge-ecovacs
```

## Configuration

Configure through the Matterbridge frontend:

| Field       | Description                              | Example          |
| ----------- | ---------------------------------------- | ---------------- |
| `username`  | Ecovacs account email                    | `me@example.com` |
| `password`  | Ecovacs account password                 |                  |
| `country`   | ISO alpha-2 country code of your account | `de`, `gb`, `us` |
| `continent` | Ecovacs continent code                   | `eu`, `na`, `as` |

> `gb` is automatically mapped to the non-standard `UK` code the Ecovacs API expects.

### Login fails with error 1013 ("Please update to the latest version")

Since mid-July 2026 Ecovacs requires every API client device ID to complete a **one-time email verification**; unverified device IDs get error 1013 (the message about updating is misleading — no version change fixes it). Run the bundled verification script once per device ID:

```bash
node scripts/verify-device.mjs <email> <password> [country] [continent] --plugin   # the plugin's device ID
node scripts/verify-device.mjs <email> <password> [country] [continent]            # the debug scripts' device ID
```

Ecovacs emails a code to your account address; enter it at the prompt and the script confirms with a normal login. Verification sticks — you only need to redo it if the machine's hostname changes (the device ID is derived from it).

## Adding support for a new model

The Ecovacs cloud API is inconsistent across robot generations — commands one model accepts are silently ignored or rejected by another. All model-specific behaviour therefore lives in a single declarative registry: [`src/models/models.ts`](src/models/models.ts), keyed by the Ecovacs device class. A model entry declares things like:

- which clean command the firmware accepts (`Clean` vs `Clean_V2`)
- how room cleans are started (`SpotArea`, `SpotArea_V2`, or the X2's `freeClean`)
- whether the robot has controllable mopping, and quirks like _"never send `DisableSweepMode` on vacuum-only runs"_ (which triggers a spurious mop-pad wash on all-in-one stations)
- whether clean state can be polled or is push-only
- which clean modes and suction speeds to expose

To work out what a new model accepts, use the interactive command console:

```bash
node scripts/test-commands.mjs <email> <password> [country] [continent]
```

It connects to your real robot, gives you a menu to fire each command variant, and logs every outgoing command (TX) and every response body code (RX) — **including silent rejections the library normally swallows** (e.g. the X2 answering `body.code=20003 "rcp not support"`). Once you know what works, add an entry to `MODELS` and open a PR.

There is also a minimal connectivity checker:

```bash
node scripts/debug-ecovacs.mjs <email> <password> [country] [continent]
```

Both scripts accept credentials via `ECOVACS_USERNAME` / `ECOVACS_PASSWORD` environment variables and `--device N` to pick a robot on multi-robot accounts.

## Development

```bash
npm install
npm link matterbridge   # link against your local Matterbridge install
npm run build
npm test
npm run lint
```

The Jest suite mocks the `ecovacs-deebot` library completely — no robot or account needed.

## Acknowledgements

- Built on [ecovacs-deebot.js](https://github.com/mrbungle64/ecovacs-deebot.js) and [Matterbridge](https://github.com/Luligu/matterbridge)
- Structure inspired by [matterbridge-xiaomi-roborock](https://github.com/afharo/matterbridge-xiaomi-roborock)

## License

Apache-2.0
