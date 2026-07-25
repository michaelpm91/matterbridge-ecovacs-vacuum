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
}

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

  /** Milliseconds to wait before attempting a reconnect after MQTT closes. */
  private static readonly RECONNECT_DELAY_MS = 30_000;

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
    // Append a suffix so the plugin's MQTT client ID differs from the debug
    // scripts (both use os.hostname()). Identical client IDs cause the MQTT
    // broker to terminate whichever connected earlier.
    const deviceId = EcoVacsAPI.getDeviceId(os.hostname() + '-mb');
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

    this.log.debug('Connecting to Ecovacs cloud...');
    await timeout(api.connect(cfg.username, EcoVacsAPI.md5(cfg.password)), 'Ecovacs auth');
    this.log.info('Ecovacs cloud connection established');

    const vacuums: EcovacsVacuum[] = await timeout(api.devices(), 'Ecovacs device list');
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
              `Please open an issue at https://github.com/michaelpm91/matterbridge-ecovacs/issues with this line so the model can be added.`,
          );
        }
        device = new VacuumDevice(this, this.log, vacuum, definition);
        this.vacuums.set(vacuum.did, device);
      }

      device.attach(api, vacuum, () => this.scheduleReconnect(cfg), EcoVacsAPI);
    }
  }

  /**
   * Schedule a reconnect attempt after RECONNECT_DELAY_MS.
   * Guards against concurrent attempts; no-ops when shutdown has started.
   *
   * @param {EcovacsPlatformConfig} cfg - The platform configuration containing credentials and region.
   */
  scheduleReconnect(cfg: EcovacsPlatformConfig): void {
    if (this.isReconnecting || this.reconnectTimer) return;
    this.isReconnecting = true;
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
      } catch (err: unknown) {
        this.log.error(`Reconnect failed: ${String(err)} — will retry`);
        this.scheduleReconnect(cfg);
      }
    }, EcovacsPlatform.RECONNECT_DELAY_MS);
  }
}
