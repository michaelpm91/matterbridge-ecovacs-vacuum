/* eslint-disable */
/**
 * Standalone debug script for testing Ecovacs API connectivity.
 *
 * Usage:
 *   node scripts/debug-ecovacs.mjs <username> <password> [country] [continent] [--device N]
 *
 * Credentials can also be provided via environment variables:
 *   ECOVACS_USERNAME=me@example.com ECOVACS_PASSWORD=secret node scripts/debug-ecovacs.mjs gb eu
 *
 * Examples:
 *   node scripts/debug-ecovacs.mjs me@example.com mypassword gb eu
 *   node scripts/debug-ecovacs.mjs me@example.com mypassword us na --device 1
 */

import os from 'node:os';
import { createRequire } from 'node:module';

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
  console.error('Usage: node scripts/debug-ecovacs.mjs <username> <password> [country] [continent] [--device N]');
  console.error('   or: ECOVACS_USERNAME=... ECOVACS_PASSWORD=... node scripts/debug-ecovacs.mjs [country] [continent]');
  process.exit(1);
}

// ── Country mapping (same as src/constants.ts) ───────────────────────────────

const ECOVACS_COUNTRY_MAP = { GB: 'UK' };

function toEcovacsCountry(c) {
  const upper = c.toUpperCase();
  return ECOVACS_COUNTRY_MAP[upper] ?? upper;
}

const country = toEcovacsCountry(rawCountry);

// ── Debug helpers ─────────────────────────────────────────────────────────────

function log(label, value) {
  console.log(`[debug] ${label}:`, value ?? '(undefined)');
}

// ── Connect ───────────────────────────────────────────────────────────────────

const deviceId = EcoVacsAPI.getDeviceId(os.hostname());
const passwordHash = EcoVacsAPI.md5(rawPassword);

log('username', username);
log('password (raw length)', rawPassword.length);
// Never print the MD5 hash — for the Ecovacs API the MD5 *is* the credential.
log('country (raw)', rawCountry);
log('country (mapped)', country);
log('continent', continent);
log('deviceId', deviceId);

const api = new EcoVacsAPI(deviceId, country, continent);

console.log('\n[debug] Connecting to Ecovacs cloud...');

try {
  await api.connect(username, passwordHash);
  console.log('[debug] ✓ Authenticated successfully');
} catch (err) {
  console.error('[debug] ✗ Authentication failed:', err.message ?? err);
  if (/1013/.test(String(err.message ?? err))) {
    // Ecovacs requires a one-time email verification per client device ID since ~2026-07-14.
    console.error('[debug]   Error 1013 means this device ID has not completed Ecovacs device verification.');
    console.error('[debug]   Run: node scripts/verify-device.mjs <username> <password> [country] [continent]');
  }
  process.exit(1);
}

log('uid', api.uid);
log('resource', api.resource);
log('user_access_token', api.user_access_token ? '(present)' : '(MISSING)');

// ── List devices ──────────────────────────────────────────────────────────────

console.log('\n[debug] Fetching device list...');
let devices;
try {
  devices = await api.devices();
} catch (err) {
  console.error('[debug] ✗ Failed to fetch devices:', err.message ?? err);
  process.exit(1);
}

if (!devices || devices.length === 0) {
  console.error('[debug] ✗ No devices found on this account');
  process.exit(1);
}

console.log(`[debug] ✓ Found ${devices.length} device(s):`);
for (const [i, d] of devices.entries()) {
  console.log(`  [${i}] name=${d.name ?? '(none)'} nick=${d.nick ?? '(none)'} did=${d.did} class=${d.class} company=${d.company ?? '?'}`);
}

const vacuum = devices[deviceIndex];
if (!vacuum) {
  console.error(`[debug] ✗ No device at index ${deviceIndex}`);
  process.exit(1);
}

// ── Connect vacbot ────────────────────────────────────────────────────────────

console.log(`\n[debug] Connecting vacbot for device: ${vacuum.nick ?? vacuum.name ?? vacuum.did}`);

const vacbot = api.getVacBot(api.uid, EcoVacsAPI.REALM, api.resource, api.user_access_token, vacuum);

vacbot.on('error', (err) => {
  console.error('[debug] vacbot error:', err);
});

vacbot.on('ready', () => {
  console.log('[debug] ✓ Vacbot ready — polling state...');
  vacbot.run('GetBatteryState');
  vacbot.run('GetChargeState');
  vacbot.run('GetCleanState');
});

vacbot.on('BatteryInfo', (battery) => {
  console.log(`[debug] BatteryInfo: ${Math.round(battery)}%`);
});

vacbot.on('CleanReport', (status) => {
  console.log(`[debug] CleanReport: ${status}`);
  shutdown();
});

vacbot.on('ChargeState', (status) => {
  console.log(`[debug] ChargeState: ${status}`);
});

vacbot.connect();

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[debug] Shutting down...');
  try {
    vacbot
      .disconnectAsync()
      .then(() => process.exit(0))
      .catch(() => {
        vacbot.disconnect();
        process.exit(0);
      });
  } catch {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);

// Auto-exit after 15 s if no CleanReport arrives
setTimeout(() => {
  console.log('[debug] Timeout — no CleanReport received within 15 s');
  shutdown();
}, 15_000);
