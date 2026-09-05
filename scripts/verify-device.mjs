#!/usr/bin/env node
/* eslint-disable */
/**
 * One-time Ecovacs device verification.
 *
 * Since ~2026-07-14 Ecovacs requires every API client device ID to complete an
 * email verification flow once; unverified device IDs get login error 1013
 * "Please update to the latest version to continue" (the message is misleading —
 * no version update fixes it). After verification the device ID stays verified
 * and normal password login works again.
 *
 * Flow (ported from DeebotUniverse/client.py PR #1706):
 *   1. common/getConfig            → fetch Ecovacs' RSA public key
 *   2. user/sendEmailVerifyCode    → Ecovacs emails a one-time code to the account address
 *   3. user/verifyDevice           → submit the code (account RSA-encrypted)
 *   4. stock login retry           → confirm the device ID is now accepted
 *
 * Usage (installed):
 *   matterbridge-ecovacs-vacuum-verify <username> <password> [country] [continent] [--device-id ID]
 * Usage (any machine, without installing):
 *   npx -p matterbridge-ecovacs-vacuum matterbridge-ecovacs-vacuum-verify <username> <password> ...
 *   (-p is required: the bin name differs from the package name, so npx cannot resolve it alone)
 * Usage (from a repo checkout):
 *   node scripts/verify-device.mjs <username> <password> [country] [continent] [--device-id ID]
 *   ECOVACS_USERNAME=... ECOVACS_PASSWORD=... node scripts/verify-device.mjs [country] [continent]
 *
 * Targets (each device ID needs its own verification / email code):
 *   default          the device ID used by scripts/debug-ecovacs.mjs and scripts/test-commands.mjs
 *   --plugin         the device ID the Matterbridge plugin derives on THIS host (hostname + '-mb')
 *   --device-id ID   an explicit device ID — use this to verify on behalf of another
 *                    machine (e.g. a Home Assistant VM): take the ID the plugin logs
 *                    at startup, verify it here, then keep it stable by setting
 *                    "deviceId" in the plugin config.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EcoVacsAPI } = require('ecovacs-deebot');

// ── Args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const forPlugin = argv.includes('--plugin');
const deviceIdFlagIdx = argv.indexOf('--device-id');
const explicitDeviceId = deviceIdFlagIdx !== -1 ? argv[deviceIdFlagIdx + 1]?.trim() : undefined;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--device-id');

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
  console.error('Usage: matterbridge-ecovacs-vacuum-verify <username> <password> [country] [continent] [--device-id ID] [--plugin]');
  console.error('   or: ECOVACS_USERNAME=... ECOVACS_PASSWORD=... matterbridge-ecovacs-vacuum-verify [country] [continent]');
  process.exit(1);
}

if (deviceIdFlagIdx !== -1 && !explicitDeviceId) {
  console.error('--device-id requires a value (the device ID the plugin logs at startup)');
  process.exit(1);
}

// ── Country / device ID (must match the other scripts and the plugin exactly) ──

const ECOVACS_COUNTRY_MAP = { GB: 'UK' };
const country = ECOVACS_COUNTRY_MAP[rawCountry.toUpperCase()] ?? rawCountry.toUpperCase();
const cc = country.toLowerCase(); // verification endpoints use lowercase everywhere

const machineId = forPlugin ? os.hostname() + '-mb' : os.hostname();
const deviceId = explicitDeviceId ?? EcoVacsAPI.getDeviceId(machineId);

const target = explicitDeviceId ? 'explicit --device-id (may belong to another host)' : forPlugin ? 'Matterbridge plugin on this host' : 'debug/test scripts on this host';

console.log(`[verify] Account:   ${username}`);
console.log(`[verify] Country:   ${country} (endpoint: gl-${cc}-api.ecovacs.com)`);
console.log(`[verify] Target:    ${target}`);
console.log(`[verify] Device ID: ${deviceId}${explicitDeviceId ? '' : ` (derived from '${machineId}')`}`);

// ── Signed private API calls (same scheme as ecovacs-deebot / deebot-client) ──

const CLIENT_KEY = '1520391301804';
const CLIENT_SECRET = '6c319b2a5cd3e66e39159c2e28f2fce9';

// Verification endpoints identify as a current app build (deebot-client PR #1706)
const META = {
  country: cc,
  lang: 'EN',
  deviceId,
  appCode: 'global_e',
  appVersion: '3.14.0',
  channel: 'google_play',
  deviceType: '1',
};

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function requestMetadata() {
  const now = Date.now();
  return { requestId: md5(String(now)), authTimespan: now, authTimeZone: 'GMT-8' };
}

function sign(params) {
  const signData = { ...META, ...params };
  const text =
    CLIENT_KEY +
    Object.keys(signData)
      .sort()
      .map((k) => `${k}=${signData[k]}`)
      .join('') +
    CLIENT_SECRET;
  return { ...params, authSign: md5(text), authAppkey: CLIENT_KEY };
}

async function callPrivateApi(endpoint, params) {
  const base = `https://gl-${cc}-api.ecovacs.com/v1/private/${cc}/EN/${deviceId}/global_e/3.14.0/google_play/1/${endpoint}`;
  const url = new URL(base);
  for (const [k, v] of Object.entries(sign(params))) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  const body = JSON.parse(await res.text()); // Ecovacs sends JSON with a text content-type
  if (body.code === '0000') return body.data;
  const err = new Error(`${endpoint} failed: code=${body.code} msg="${body.msg}"`);
  err.code = body.code;
  throw err;
}

// ── Flow ──────────────────────────────────────────────────────────────────────

console.log('\n[verify] Fetching Ecovacs RSA public key (common/getConfig)...');
const config = await callPrivateApi('common/getConfig', { keys: 'PUBLIC.KEY.CONFIG', ...requestMetadata() });
const entry = (Array.isArray(config) ? config : []).find((e) => e?.key === 'PUBLIC.KEY.CONFIG');
if (!entry?.value) {
  console.error('[verify] ✗ Public key missing from getConfig response:', JSON.stringify(config).slice(0, 300));
  process.exit(1);
}
const publicKeyDer = Buffer.from(JSON.parse(entry.value).publicKey, 'base64');
const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
console.log('[verify] ✓ Public key received');

const encryptAccount = () => crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(username)).toString('base64');

console.log('[verify] Requesting verification code (user/sendEmailVerifyCode)...');
await callPrivateApi('user/sendEmailVerifyCode', {
  encryptEmail: encryptAccount(),
  verifyType: 'EMAIL_VERIFY_DEVICE',
  supportChar: 'N',
  isForce: 'N',
  ...requestMetadata(),
});
console.log(`[verify] ✓ Code sent — check the inbox of ${username} (and spam folder)`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let verified = false;
for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
  const code = (await rl.question('\nEnter the verification code from the email: ')).trim();
  if (!code) continue;
  try {
    const data = await callPrivateApi('user/verifyDevice', {
      encryptAccount: encryptAccount(),
      backUpEmail: '',
      verifyCode: code,
      model: 'Pixel 7',
      system: 'Android 14',
      ...requestMetadata(),
    });
    if (!data?.uid || !data?.accessToken) {
      console.error('[verify] ✗ Unexpected verifyDevice response:', JSON.stringify(data).slice(0, 300));
      process.exit(1);
    }
    verified = true;
  } catch (err) {
    if (err.code === '1012') {
      console.error(`[verify] ✗ Invalid code (attempt ${attempt}/3): ${err.message}`);
    } else {
      console.error('[verify] ✗', err.message);
      process.exit(1);
    }
  }
}
rl.close();

if (!verified) {
  console.error('[verify] ✗ No valid code entered — run the script again to request a fresh code.');
  process.exit(1);
}

console.log('\n[verify] ✓ Device verified!');

// ── Confirm with a normal stock login ────────────────────────────────────────

console.log('[verify] Confirming with a stock login (this is what the plugin/scripts do)...');
const api = new EcoVacsAPI(deviceId, country, continent);
try {
  await api.connect(username, EcoVacsAPI.md5(rawPassword));
  console.log('[verify] ✓ Stock login succeeded — this device ID is fully working.');
  if (explicitDeviceId) {
    console.log('[verify] Set this in the plugin config so the ID stays stable, then restart the plugin:');
    console.log(`[verify]     "deviceId": "${deviceId}"`);
  } else if (forPlugin) {
    console.log('[verify] The Matterbridge plugin on this machine will now authenticate normally.');
  } else {
    console.log('[verify] scripts/debug-ecovacs.mjs and scripts/test-commands.mjs will now authenticate normally.');
    console.log('[verify] To also verify the Matterbridge plugin device ID, run again with --plugin (needs a fresh email code).');
  }
} catch (err) {
  console.error('[verify] ✗ Verification succeeded but stock login still failed:', err.message ?? err);
  process.exit(1);
}
process.exit(0);
