/**
 * EcovacsPlatform — Matterbridge Dynamic Platform for Ecovacs robot vacuums.
 *
 * Handles Ecovacs cloud authentication, device discovery, and connection
 * recovery. Each robot found on the account is bridged by a {@link VacuumDevice}.
 *
 * @file platform.ts
 * @license Apache-2.0
 */

import os from 'node:os';

import { EcoVacsAPI } from 'ecovacs-deebot';
import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { toEcovacsCountry } from './constants.js';
import { resolveModel } from './models/models.js';
import { EcovacsVacuum, VacuumDevice } from './vacuum_device.js';

/** Plugin configuration as edited in the Matterbridge frontend. */
export interface EcovacsPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  country: string;
  continent: string;
  /**
   * Ecovacs client device ID. Optional — when empty the plugin derives one from
   * the hostname on first start and persists it. Set explicitly to reuse a
   * device ID that has already passed Ecovacs device verification (see the
   * `verify-device` CLI), which is what makes it possible to run the
   * verification on a machine other than the Matterbridge host.
   */
  deviceId?: string;
}

/**
 * Cached Ecovacs cloud session, persisted in the plugin's node storage.
 * Reusing the access token across Matterbridge restarts avoids a fresh login
 * every start — Ecovacs re-triggers device verification (error 1013) when it
 * sees too many logins from one device ID. The token is as sensitive as the
 * password already stored in the plugin config; both live in the same
 * Matterbridge storage directory.
 */
interface CachedSession {
  uid: string;
  token: string;
  /** Epoch ms after which the cached token is no longer trusted. */
  expiresAt: number;
  /** Hash of username|country|deviceId — invalidates the cache when any of them change. */
  fingerprint: string;
}

/** Storage key for the cached Ecovacs session. */
const SESSION_KEY = 'ecovacsSession';

/** Storage key for the persisted Ecovacs client device ID. */
const DEVICE_ID_KEY = 'ecovacsDeviceId';

/** Trust cached tokens for 6.5 days — Ecovacs tokens are valid for ~7. */
const SESSION_TTL_MS = 6.5 * 24 * 60 * 60 * 1000;

/** Matterbridge Dynamic Platform bridging Ecovacs robot vacuums (Deebot, yeedi) to Matter. */
export class EcovacsPlatform extends MatterbridgeDynamicPlatform {
  /** Bridged robots keyed by Ecovacs device ID (did). */
  readonly vacuums: Map<string, VacuumDevice> = new Map();

  /** Reconnect timer — pending setTimeout handle when waiting to reconnect */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while a reconnect attempt is in progress; prevents concurrent attempts */
  private isReconnecting: boolean = false;

  /** Milliseconds to wait for the Ecovacs cloud HTTP calls before giving up. */
  private static readonly CLOUD_TIMEOUT_MS = 15_000;

  /**
   * Backoff schedule for reconnect attempts. A dropped MQTT connection is often
   * momentary, so the first retry is quick; repeated failures (cloud outage)
   * back off rather than hammering the API, which is also what provokes Ecovacs
   * into demanding device verification again.
   */
  private static readonly RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

  /** Index into RECONNECT_DELAYS_MS; reset on a successful connect. */
  private reconnectAttempt: number = 0;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing Ecovacs Platform...');
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;

    const cfg = this.config as EcovacsPlatformConfig;

    if (!cfg.username || !cfg.password) {
      this.log.error('Ecovacs credentials are not configured. Please set username and password in the plugin config.');
      return;
    }

    try {
      await this.connectEcovacs(cfg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to connect to Ecovacs cloud: ${message}`);
      if (message.includes('1013')) {
        // Ecovacs requires a one-time email verification per client device ID.
        // The message it returns ("please update to the latest version") is misleading.
        const deviceId = await this.resolveDeviceId(cfg);
        this.log.error(
          `This Ecovacs device ID has not completed device verification. Run the verification once, ` +
            `then restart the plugin:\n` +
            `    npx matterbridge-ecovacs-vacuum-verify ${cfg.username} <password> ${cfg.country} ${cfg.continent} --device-id ${deviceId}\n` +
            `It can be run from any machine (it does not have to be this host) — Ecovacs emails a code to the account address. ` +
            `Keep the device ID stable afterwards: set "deviceId": "${deviceId}" in the plugin config if you may reinstall or move hosts.`,
        );
      }
    }
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const device of this.getDevices()) {
      this.log.info(`Configuring device: ${device.uniqueId}`);
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    // Inherited from MatterbridgePlatform; a pending reconnect checks this so it
    // no-ops instead of racing teardown.
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const device of this.vacuums.values()) {
      await device.detach();
    }

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  // ── Ecovacs connection ──────────────────────────────────────────────────────

  /**
   * Authenticate with the Ecovacs cloud, discover the robots on the account, and
   * attach a vacbot to each. Safe to call again after a connection loss — already
   * known robots keep their Matter endpoint and only get a fresh vacbot.
   *
   * @param {EcovacsPlatformConfig} cfg - The platform configuration containing credentials and region.
   */
  private async connectEcovacs(cfg: EcovacsPlatformConfig): Promise<void> {
    const deviceId = await this.resolveDeviceId(cfg);
    const ecovacsCountry = toEcovacsCountry(cfg.country);
    this.log.debug(`Using Ecovacs country code: ${ecovacsCountry} (from config: ${cfg.country})`);
    const api = new EcoVacsAPI(deviceId, ecovacsCountry, cfg.continent);

    // Wrap HTTP calls with a timeout so onStart never hangs indefinitely if the
    // Ecovacs cloud is unreachable or slow to respond.
    const timeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${EcovacsPlatform.CLOUD_TIMEOUT_MS / 1000}s`)), EcovacsPlatform.CLOUD_TIMEOUT_MS),
        ),
      ]);

    const fingerprint = EcoVacsAPI.md5(`${cfg.username}|${ecovacsCountry}|${deviceId}`);
    let vacuums: EcovacsVacuum[] | null = null;

    // Try the cached session first: inject uid/token and validate them with a
    // real API call. Any rejection falls through to a full login.
    const cached = await this.context?.get<CachedSession | undefined>(SESSION_KEY, undefined);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
      api.uid = cached.uid;
      api.user_access_token = cached.token;
      try {
        vacuums = await timeout(api.devices(), 'Ecovacs device list');
        this.log.info('Reusing cached Ecovacs session (no fresh login needed)');
      } catch (err: unknown) {
        this.log.info(`Cached Ecovacs session rejected (${err instanceof Error ? err.message : String(err)}) — performing full login`);
        vacuums = null;
      }
    }

    if (!vacuums) {
      this.log.debug('Connecting to Ecovacs cloud...');
      await timeout(api.connect(cfg.username, EcoVacsAPI.md5(cfg.password)), 'Ecovacs auth');
      this.log.info('Ecovacs cloud connection established');
      await this.context?.set<CachedSession>(SESSION_KEY, {
        uid: api.uid,
        token: api.user_access_token,
        expiresAt: Date.now() + SESSION_TTL_MS,
        fingerprint,
      });
      vacuums = await timeout(api.devices(), 'Ecovacs device list');
    }

    if (!vacuums || vacuums.length === 0) {
      this.log.error('No Ecovacs devices found on this account.');
      return;
    }

    for (const vacuum of vacuums) {
      this.log.info(`Found device: ${vacuum.nick ?? vacuum.name ?? vacuum.did} (class: ${vacuum.class})`);

      let device = this.vacuums.get(vacuum.did);
      if (!device) {
        const { definition, matched } = resolveModel(vacuum.class);
        if (matched) {
          this.log.info(`Using model profile: ${definition.name}`);
        } else {
          this.log.warn(
            `Unknown Ecovacs device class '${vacuum.class}' — using the default profile (vacuum only). ` +
              `Please open an issue at https://github.com/michaelpm91/matterbridge-ecovacs-vacuum/issues with this line so the model can be added.`,
          );
        }
        device = new VacuumDevice(this, this.log, vacuum, definition);
        this.vacuums.set(vacuum.did, device);
      }

      device.attach(api, vacuum, () => this.scheduleReconnect(cfg), EcoVacsAPI);
    }
  }

  /**
   * Determine the Ecovacs client device ID to authenticate with.
   *
   * Precedence: explicit config value → previously persisted value → derived
   * from the hostname (and then persisted). Persisting matters because Ecovacs
   * ties device verification to this ID: a value that silently changed (e.g.
   * because the host was renamed) would fail login with error 1013 until the
   * verification was repeated.
   *
   * @param {EcovacsPlatformConfig} cfg - The platform configuration.
   * @returns {Promise<string>} The device ID to use.
   */
  private async resolveDeviceId(cfg: EcovacsPlatformConfig): Promise<string> {
    const configured = cfg.deviceId?.trim();
    if (configured) {
      this.log.info(`Using Ecovacs device ID from config: ${configured}`);
      return configured;
    }

    const stored = await this.context?.get<string | undefined>(DEVICE_ID_KEY, undefined);
    if (stored) {
      this.log.info(`Using stored Ecovacs device ID: ${stored}`);
      return stored;
    }

    // Suffix the hostname so this ID differs from the one the debug scripts use
    // (they use the bare hostname): identical MQTT client IDs make the broker
    // terminate whichever connection was established earlier.
    const derived = EcoVacsAPI.getDeviceId(os.hostname() + '-mb');
    await this.context?.set<string>(DEVICE_ID_KEY, derived);
    this.log.info(`Generated Ecovacs device ID: ${derived} (from hostname '${os.hostname()}', now persisted)`);
    return derived;
  }

  /**
   * Schedule a reconnect attempt, backing off on repeated failures.
   * Guards against concurrent attempts; no-ops when shutdown has started.
   *
   * @param {EcovacsPlatformConfig} cfg - The platform configuration containing credentials and region.
   */
  scheduleReconnect(cfg: EcovacsPlatformConfig): void {
    if (this.isReconnecting || this.reconnectTimer) return;
    this.isReconnecting = true;
    const delays = EcovacsPlatform.RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    this.log.info(`Scheduling Ecovacs reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      if (this.isShuttingDown) return; // shutdown beat us to it
      this.log.info('Attempting Ecovacs reconnect...');
      try {
        for (const device of this.vacuums.values()) {
          await device.detach();
        }
        await this.connectEcovacs(cfg);
        this.reconnectAttempt = 0;
      } catch (err: unknown) {
        this.log.error(`Reconnect failed: ${String(err)} — will retry`);
        this.scheduleReconnect(cfg);
      }
    }, delay);
  }
}
