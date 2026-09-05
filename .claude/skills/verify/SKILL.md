---
name: verify
description: Run this plugin under a real, isolated Matterbridge instance and observe its runtime behaviour (plugin load, onStart, Ecovacs cloud connection).
---

# Verifying matterbridge-ecovacs-vacuum

The jest suite mocks `ecovacs-deebot` entirely — runtime verification means
loading the plugin into a **real Matterbridge** and watching the log.

## Isolated Matterbridge run (no impact on any production install)

```bash
npm run build                       # plugin is loaded from dist/

MBHOME=$(mktemp -d)/mb-home
matterbridge --homedir "$MBHOME" --add .          # register plugin (creates $MBHOME/.matterbridge)
matterbridge --homedir "$MBHOME" --bridge --logger debug \
  --frontend 18283 --port 15540 --no-ansi         # non-default ports avoid clashes
```

Run it in the background with output to a file, give it ~20 s, then kill it and
grep the log. Startup is fast; the Ecovacs cloud call happens right after
`onStart called with reason: Matterbridge is starting`.

## What to look for

- `Loaded plugin matterbridge-ecovacs-vacuum type DynamicPlatform` — module entrypoint OK
- `Initializing Ecovacs Platform...` — constructor + version check passed
- No credentials in config → `Ecovacs credentials are not configured...` (clean error, bridge keeps running)
- Bogus credentials → `Failed to connect to Ecovacs cloud: Failure code 1010: Incorrect account or password`
  (real cloud round-trip through ecovacs-deebot; proves the catch path, no unhandled rejection)
- `country: gb` in config → debug line `Using Ecovacs country code: UK (from config: gb)`
- Real credentials → `Found device: <name> (class: <class>)`, `Using model profile: ...`,
  `Discovered N room(s): ...`, `<name> registered as Matter RVC device with N room(s)`

Plugin config lives at `$MBHOME/.matterbridge/matterbridge-ecovacs-vacuum.config.json`
(created from the repo's default config on first run) — edit it between runs to
change credentials/country.

## Gotchas

- Since ~2026-07-14 Ecovacs requires one-time email verification per client
  device ID; unverified IDs fail login with error 1013 "Please update to the
  latest version" (misleading — version strings are irrelevant). Fix with
  `node scripts/verify-device.mjs <email> <password> [country] [continent]`
  (add `--plugin` for the plugin's device ID). Device IDs derive from
  `os.hostname()`, so a hostname change re-triggers 1013. Verification can
  also be re-demanded after many logins from one device ID in a short window.
- Fake/nonexistent accounts do NOT trip the 1013 gate (nothing to verify), so
  bogus-credential probes still exercise the login path and return 1010.

- The log prefix is the package.json `description` — keep it short.
- Real-credential runs open an MQTT session; the plugin appends `-mb` to the
  client ID so it won't kick a production instance on a _different_ host, but
  two instances on the _same_ host with the same suffix will fight.
- Credential-less verification is still meaningful: it covers the whole
  Matterbridge↔plugin seam that the mocked tests cannot.

## Cloud-side verification without Matter

`node scripts/test-commands.mjs <email> <password> [country] [continent]` —
interactive console against the real robot with TX/RX tracing (surfaces
silently rejected commands). `scripts/debug-ecovacs.mjs` is the minimal
connectivity check. Both accept `ECOVACS_USERNAME`/`ECOVACS_PASSWORD` env vars.
