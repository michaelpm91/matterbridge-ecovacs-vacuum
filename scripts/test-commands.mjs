/* eslint-disable */
/**
 * Interactive command test console for Ecovacs robots.
 *
 * Connects to the real robot and lets you fire every command the plugin uses,
 * so you can validate model behaviour locally before involving the Matter /
 * HomeKit flow. Every outgoing command (TX) and every response body code (RX)
 * is logged — including silent rejections (body.code != 0) that the
 * ecovacs-deebot library swallows in production. This is the fastest way to
 * work out which command variants a new model actually accepts when building
 * its entry for src/models/models.ts.
 *
 * Usage:
 *   node scripts/test-commands.mjs <username> <password> [country] [continent] [--device N] [--verbose]
 *
 * Credentials can also be provided via environment variables:
 *   ECOVACS_USERNAME=me@example.com ECOVACS_PASSWORD=secret node scripts/test-commands.mjs gb eu
 *
 * --verbose enables full MQTT trace from the ecovacs-deebot library (NODE_ENV=development)
 */

import os from 'node:os';
import readline from 'node:readline';
import { createRequire } from 'node:module';

// Enable verbose MQTT logging before the library is loaded
if (process.argv.includes('--verbose')) {
  process.env.NODE_ENV = 'development';
  console.log('[test] Verbose mode enabled (NODE_ENV=development)\n');
}

const require = createRequire(import.meta.url);
const { EcoVacsAPI } = require('ecovacs-deebot');

// ── Args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const deviceFlagIdx = argv.indexOf('--device');
const deviceIndex = deviceFlagIdx !== -1 ? Number(argv[deviceFlagIdx + 1] ?? 0) : 0;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--device');

let username = process.env.ECOVACS_USERNAME;
let rawPassword = process.env.ECOVACS_PASSWORD;
let rawCountry = 'de';
let continent = 'eu';

if (username && rawPassword) {
  [rawCountry = 'de', continent = 'eu'] = positional;
} else {
  [username, rawPassword, rawCountry = 'de', continent = 'eu'] = positional;
}

if (!username || !rawPassword) {
  console.error('Usage: node scripts/test-commands.mjs <username> <password> [country] [continent] [--device N] [--verbose]');
  console.error('   or: ECOVACS_USERNAME=... ECOVACS_PASSWORD=... node scripts/test-commands.mjs [country] [continent]');
  process.exit(1);
}

const ECOVACS_COUNTRY_MAP = { GB: 'UK' };
const country = ECOVACS_COUNTRY_MAP[rawCountry.toUpperCase()] ?? rawCountry.toUpperCase();

// ── State ─────────────────────────────────────────────────────────────────────

let rooms = []; // [{ id: string, name: string }]
let currentMapMID = null;

// ── Connect ───────────────────────────────────────────────────────────────────

console.log(`\n[test] Connecting to Ecovacs cloud (country=${country}, continent=${continent})...`);

const deviceId = EcoVacsAPI.getDeviceId(os.hostname());
const api = new EcoVacsAPI(deviceId, country, continent);

try {
  await api.connect(username, EcoVacsAPI.md5(rawPassword));
  console.log('[test] ✓ Authenticated');
} catch (err) {
  console.error('[test] ✗ Auth failed:', err.message ?? err);
  if (/1013/.test(String(err.message ?? err))) {
    // Ecovacs requires a one-time email verification per client device ID since ~2026-07-14.
    console.error('[test]   Error 1013: run `node scripts/verify-device.mjs` first to verify this device ID.');
  }
  process.exit(1);
}

const devices = await api.devices();
if (!devices?.length) {
  console.error('[test] ✗ No devices found');
  process.exit(1);
}

console.log(`[test] Found ${devices.length} device(s):`);
for (const [i, d] of devices.entries()) {
  console.log(`  [${i}] ${d.nick ?? d.name ?? d.did} (class: ${d.class})${i === deviceIndex ? '  ← selected' : ''}`);
}

const vacuum = devices[deviceIndex];
if (!vacuum) {
  console.error(`[test] ✗ No device at index ${deviceIndex} — pass --device N`);
  process.exit(1);
}

console.log(`[test] Using device: ${vacuum.nick ?? vacuum.name ?? vacuum.did} (class: ${vacuum.class})`);

const vacbot = api.getVacBot(api.uid, EcoVacsAPI.REALM, api.resource, api.user_access_token, vacuum);

// Patch ecovacs internals to log every command sent and every response body code.
// This exposes silent rejections (body.code != 0) that the library swallows in production.

const _origSend = vacbot.ecovacs.sendCommand.bind(vacbot.ecovacs);
vacbot.ecovacs.sendCommand = async (cmd) => {
  // Log the outgoing payload (filter out noisy map/position commands)
  const skip = ['GetMapImage', 'PullMP', 'GetPos'].some((n) => cmd?.name?.startsWith(n));
  if (!skip) {
    console.log(`  → TX [${cmd?.name ?? '?'}]  ${JSON.stringify(cmd?.args ?? cmd)}`);
  }
  return _origSend(cmd);
};

const _origHandleMsg = vacbot.ecovacs.handleMessage.bind(vacbot.ecovacs);
vacbot.ecovacs.handleMessage = (topic, message, type = 'incoming') => {
  // For command responses, surface the body code so we can see rejections
  if (type === 'response') {
    try {
      const parsed = typeof message === 'string' ? JSON.parse(message) : message;
      const code = parsed?.body?.code;
      const msg = parsed?.body?.msg ?? '';
      const cmd = topic ?? '?';
      if (code !== 0 && code !== undefined) {
        console.log(`  ← RX [${cmd}]  REJECTED  body.code=${code} msg="${msg}"`);
      } else {
        console.log(`  ← RX [${cmd}]  ok  ${JSON.stringify(parsed?.body?.data ?? '')}`);
      }
    } catch {}
  }
  return _origHandleMsg(topic, message, type);
};

// ── Event output ──────────────────────────────────────────────────────────────

vacbot.on('Error', (v) => console.log(`  ← Error:            ${v}`));
vacbot.on('ErrorCode', (v) => console.log(`  ← ErrorCode:        ${v}`));
vacbot.on('LastError', (v) => console.log(`  ← LastError:        code=${v?.code} "${v?.error}"`));
vacbot.on('BatteryInfo', (v) => console.log(`  ← BatteryInfo:      ${Math.round(v)}%`));
vacbot.on('CleanReport', (v) => console.log(`  ← CleanReport:      ${v}`));
vacbot.on('ChargeState', (v) => console.log(`  ← ChargeState:      ${v}`));
vacbot.on('StationState', (v) => console.log(`  ← StationState:     ${JSON.stringify(v)}`));
vacbot.on('WaterInfo', (v) => console.log(`  ← WaterInfo:        ${JSON.stringify(v)}  (sweepType: 0=combined/none, 1=mop-only)`));
vacbot.on('CurrentSpotAreas', (v) => console.log(`  ← CurrentSpotAreas: ${v}`));

vacbot.on('CurrentMapMID', (mid) => {
  currentMapMID = mid;
  console.log(`  ← CurrentMapMID: ${mid} — requesting spot areas...`);
  vacbot.run('GetSpotAreas', mid);
});

let pendingAreaCount = 0;

vacbot.on('MapSpotAreas', (data) => {
  const areas = data?.mapSpotAreas ?? [];
  console.log(`  ← MapSpotAreas:  ${areas.length} area(s) — fetching names...`);
  rooms = [];
  pendingAreaCount = areas.length;
  for (const a of areas) {
    vacbot.run('GetSpotAreaInfo', currentMapMID, a.mapSpotAreaID);
  }
  if (areas.length === 0) console.log('  (no spot areas configured on this map)');
});

vacbot.on('MapSpotAreaInfo', (info) => {
  rooms.push({ id: String(info.mapSpotAreaID), name: String(info.mapSpotAreaName) });
  pendingAreaCount--;
  if (pendingAreaCount <= 0) {
    console.log('  ✓ Rooms ready — use these IDs with cf<id> / cs<id>:');
    for (const room of rooms) console.log(`    cf${room.id}  →  ${room.name}`);
  }
});

// ── Ready → show menu ─────────────────────────────────────────────────────────

vacbot.on('ready', () => {
  console.log('[test] ✓ Vacbot ready\n');
  showMenu();
  prompt();
});

vacbot.connect();

// ── Menu ──────────────────────────────────────────────────────────────────────

function showMenu() {
  console.log('─────────────────────────────────────────────────');
  console.log(' State');
  console.log('  s       Poll state (battery + charge + clean + WaterInfo/sweepType)');
  console.log('  r       Discover rooms (run this before cf<id> / cs<id>)');
  console.log('  l       List discovered rooms and their IDs');
  console.log('');
  console.log(' Clean (full house)');
  console.log('  ca      Vacuum only  (Clean_V2, no setSweepMode) ← X2-family profile');
  console.log('  cad     Vacuum only  (DisableSweepMode + Clean_V2)');
  console.log('  cm      Mop only     (EnableSweepMode  + Clean_V2)');
  console.log('  cv      Vacuum & Mop (DisableSweepMode + Clean_V2)');
  console.log('  cl      Vacuum only  (legacy Clean command, non-V2)');
  console.log('');
  console.log(' Clean (spot area) — run "r" first, then use IDs shown');
  console.log('  cf<id>  freeClean via clean_V2   e.g. cf0 cf15  ← X2-family strategy');
  console.log('  cs<id>  SpotArea_V2              e.g. cs0 cs15  ← standard 950-type strategy');
  console.log('          (compare both to find out what a new model accepts)');
  console.log('');
  console.log(' Control');
  console.log('  p       Pause');
  console.log('  x       Resume');
  console.log('  h       Go home (dock)');
  console.log('  0       Stop');
  console.log('');
  console.log('  ?       Show this menu');
  console.log('  q       Quit');
  console.log('─────────────────────────────────────────────────');
}

// ── Readline prompt ───────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\ncmd> ' });

function prompt() {
  rl.prompt();
}

rl.on('line', (line) => {
  const cmd = line.trim();

  if (cmd === 's') {
    console.log('[test] → GetBatteryState + GetChargeState + GetCleanState + GetWaterInfo');
    vacbot.run('GetBatteryState');
    vacbot.run('GetChargeState');
    vacbot.run('GetCleanState');
    vacbot.run('GetWaterInfo');
  } else if (cmd === 'r') {
    console.log('[test] → GetMaps (chain: CurrentMapMID → GetSpotAreas → GetSpotAreaInfo × n)');
    vacbot.run('GetMaps');
  } else if (cmd === 'l') {
    if (rooms.length === 0) {
      console.log('[test] No rooms discovered yet — run "r" first');
    } else {
      console.log('[test] Discovered rooms:');
      for (const room of rooms) console.log(`  [${room.id}] ${room.name}`);
    }
  } else if (cmd === 'ca') {
    console.log('[test] → Clean_V2 (Vacuum only — no setSweepMode; check WaterInfo before/after)');
    vacbot.run('Clean_V2');
  } else if (cmd === 'cad') {
    console.log('[test] → DisableSweepMode + Clean_V2 (Vacuum only — explicit setSweepMode(0))');
    console.log('[test]    Watch for WaterInfo + CleanReport: washing to see if mop pre-wash is triggered');
    vacbot.run('DisableSweepMode');
    vacbot.run('Clean_V2');
  } else if (cmd === 'cm') {
    console.log('[test] → EnableSweepMode + Clean_V2 (Mop only)');
    vacbot.run('EnableSweepMode');
    vacbot.run('Clean_V2');
  } else if (cmd === 'cv') {
    console.log('[test] → DisableSweepMode + Clean_V2 (Vacuum & Mop)');
    vacbot.run('DisableSweepMode');
    vacbot.run('Clean_V2');
  } else if (cmd === 'cl') {
    console.log('[test] → Clean (legacy non-V2 command — 950-type robots silently ignore this)');
    vacbot.run('Clean');
  } else if (/^cf\d+$/.test(cmd)) {
    const areaId = cmd.slice(2);
    // freeClean value format: "1,areaId" per room, joined with semicolons (from X2 app traffic).
    // No DisableSweepMode: sending setSweepMode(0) triggers the mop wash cycle at the station.
    const value = `1,${areaId}`;
    const payload = { act: 'start', content: { count: 1, donotClean: '', type: 'freeClean', value }, mode: '', router: 'plan' };
    console.log(`[test] → Generic('clean_V2', type=freeClean, value="${value}") (no setSweepMode)`);
    vacbot.run('Generic', 'clean_V2', payload);
  } else if (/^cs\d+$/.test(cmd)) {
    const areaId = cmd.slice(2);
    // Standard 950-type V2 spot area command. Rejected by X2 firmware (body.code=20011).
    console.log(`[test] → SpotArea_V2('${areaId}', 1)`);
    vacbot.run('SpotArea_V2', areaId, 1);
  } else if (cmd === 'p') {
    console.log('[test] → pause()');
    vacbot.pause();
  } else if (cmd === 'x') {
    console.log('[test] → resume()');
    vacbot.resume();
  } else if (cmd === 'h') {
    console.log('[test] → charge() (go home)');
    vacbot.charge();
  } else if (cmd === '0') {
    console.log('[test] → stop()');
    vacbot.stop();
  } else if (cmd === '?') {
    showMenu();
  } else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
    shutdown();
    return;
  } else if (cmd !== '') {
    console.log(`[test] Unknown command: "${cmd}" — type ? for help`);
  }

  prompt();
});

rl.on('close', () => shutdown());

// ── Shutdown ──────────────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  console.log('\n[test] Disconnecting...');
  vacbot
    .disconnectAsync()
    .then(() => process.exit(0))
    .catch(() => {
      vacbot.disconnect();
      process.exit(0);
    });
}

process.on('SIGINT', shutdown);
