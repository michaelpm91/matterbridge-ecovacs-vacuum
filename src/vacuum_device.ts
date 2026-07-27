/**
 * VacuumDevice — bridges one Ecovacs robot vacuum to a Matter RVC device.
 *
 * Owns the vacbot connection for a single robot: translates pushed Ecovacs
 * events into Matter attribute updates and Matter commands into the Ecovacs
 * command variants declared by the robot's model definition.
 *
 * @file vacuum_device.ts
 * @license Apache-2.0
 */

import { RoboticVacuumCleaner } from 'matterbridge/devices';
import type { AnsiLogger } from 'matterbridge/logger';

import {
  BAT_CHARGE_LEVEL,
  BAT_CHARGE_STATE,
  buildSpeedLevelMap,
  buildSupportedCleanModes,
  CLEAN_MODE_NUMBER,
  ECOVACS_EXTRA_DESCRIPTIONS,
  ECOVACS_TO_RVC_ERROR,
  ECOVACS_WORK_MODE,
  OP_STATE,
  RUN_MODE,
  RVC_ERROR,
} from './constants.js';
import type { CleanModeKey, ModelDefinition } from './models/types.js';
import type { EcovacsPlatform } from './platform.js';

/** A named room (spot area) from the robot's saved map. */
export interface SpotRoom {
  id: string; // Ecovacs spot area ID (e.g. '0', '1', '2')
  name: string; // Display name from Ecovacs map data
}

/** Subset of the Ecovacs device-list record that we use. */
export interface EcovacsVacuum {
  did: string;
  name?: string;
  nick?: string;
  class?: string;
  [key: string]: unknown;
}

/** Milliseconds between keepalive state polls. */
const KEEPALIVE_INTERVAL_MS = 90_000;

/**
 * Map an Ecovacs CleanReport value to the cleaning-side operational state.
 *
 * `Stopped` means "the robot is not running a task" and defers to the dock's
 * view in {@link VacuumDevice.applyState} — that covers 'idle'/'stop' as well as
 * the station's own activities ('washing', 'drying', 'airdrying'), during which
 * the robot sits on the dock.
 *
 * @param {string} value - The CleanReport value pushed by the robot.
 * @returns {number} The matching RVC operational state.
 */
function cleanReportToOpState(value: string): number {
  switch (value) {
    // Active cleaning. 'entrust'/'qcClean'/'singlePoint'/'move'/'comeClean' are
    // started from the Ecovacs app (AI clean, quick clean, spot, manual drive);
    // without them an app-initiated run would show as Docked in the controller.
    case 'auto':
    case 'spot':
    case 'spot_area':
    case 'custom_area':
    case 'area':
    case 'entrust':
    case 'qcClean':
    case 'singlePoint':
    case 'move':
    case 'comeClean':
      return OP_STATE.Running;
    case 'pause':
      return OP_STATE.Paused;
    case 'returning':
    case 'goCharging':
      return OP_STATE.SeekingCharger;
    default:
      return OP_STATE.Stopped;
  }
}

/** Bridges one Ecovacs robot vacuum to a Matter RVC endpoint. */
export class VacuumDevice {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private vacbot: any = null;
  private rvc: RoboticVacuumCleaner | null = null;
  private currentCleanMode: number;
  private currentSpeedMode: number | null = null;

  /** Matter speed mode number → ecovacs-deebot SetCleanSpeed level */
  private readonly speedLevelMap: Map<number, number>;

  /**
   * Raw ChargeState value last pushed by the dock. One of the two independent
   * state inputs resolved by {@link applyState}; see also {@link chargeState}.
   */
  private lastChargeStatus: string = 'idle';

  /**
   * Cleaning-side operational state derived from CleanReport. `Stopped` means
   * "no task running", which defers to the dock's state in {@link applyState}.
   */
  private cleanState: number = OP_STATE.Stopped;

  /** Maps Matter ServiceArea areaId → Ecovacs spot area ID string */
  private spotAreaMap: Map<number, string> = new Map();

  /** Currently selected Matter area IDs (set via HomeKit room picker) */
  private selectedAreaIds: number[] = [];

  /** Periodic keepalive poll to refresh state and maintain subscriptions */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Last-written RVC state values — used to skip redundant setAttribute calls */
  private lastRunMode: number = -1;
  private lastOpState: number = -1;
  private lastErrorId: number = -1;
  private lastBatChargeState: number = -1;
  /** Last known battery percentage — used to determine IsAtFullCharge */
  private lastBatteryPct: number = 0;

  /**
   * True when the robot is paused (either by our pause command or CleanReport: pause).
   * Used to send vacbot.resume() instead of startClean() when HomeKit sends changeToMode
   * with SpotCleaning(4) as a resume-after-pause action.
   *
   * @returns {boolean} True when the robot is paused mid-floor.
   */
  private get isRobotPaused(): boolean {
    // A pause reported while the dock is charging means an interrupted task on a
    // docked robot, not a robot paused mid-floor waiting to be resumed.
    return this.cleanState === OP_STATE.Paused && this.chargeState !== OP_STATE.Charging;
  }

  /**
   * True after we send vacbot.resume() and before the robot confirms it's running again.
   * Some firmwares (X2) push a delayed CleanReport: pause after the original pause command;
   * this can arrive after we have already sent resume. The flag lets us discard that stale event.
   */
  private resumePending: boolean = false;

  constructor(
    private readonly platform: EcovacsPlatform,
    private readonly log: AnsiLogger,
    private vacuum: EcovacsVacuum,
    readonly definition: ModelDefinition,
  ) {
    this.currentCleanMode = CLEAN_MODE_NUMBER[definition.cleanModes[0] ?? 'vacuum'];
    this.speedLevelMap = buildSpeedLevelMap(definition);
  }

  /**
   * Display name for the Matter device: account nickname, cloud name, or model family name.
   *
   * @returns {string} The display name.
   */
  get name(): string {
    return this.vacuum.nick || this.vacuum.name || this.definition.name;
  }

  // ── Vacbot lifecycle ────────────────────────────────────────────────────────

  /**
   * Create and connect a vacbot for this robot. Called on initial start and again
   * after every reconnect; the Matter RVC endpoint is only created the first time.
   *
   * @param {object} api - An authenticated EcoVacsAPI instance.
   * @param {EcovacsVacuum} vacuum - The (fresh) device-list record for this robot.
   * @param {() => void} onConnectionLost - Invoked when the MQTT connection closes unexpectedly.
   * @param {object} EcoVacsAPIClass - The EcoVacsAPI class (for the REALM constant).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attach(api: any, vacuum: EcovacsVacuum, onConnectionLost: () => void, EcoVacsAPIClass: any): void {
    this.vacuum = vacuum;
    this.vacbot = api.getVacBot(api.uid, EcoVacsAPIClass.REALM, api.resource, api.user_access_token, vacuum);

    // Reconnect when the MQTT connection closes unexpectedly.
    // The mqtt library re-establishes the socket, but vacbot state and event
    // subscriptions are not automatically restored — we need a full reconnect.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mqttClient = (this.vacbot.ecovacs as any)?.client;
    if (mqttClient) {
      mqttClient.on('close', () => {
        this.log.warn(`MQTT connection closed — scheduling reconnect`);
        onConnectionLost();
      });
    }

    // Register ready handler before connecting
    this.vacbot.on('ready', async () => {
      this.log.info('Vacbot ready — fetching rooms and setting up Matter device');

      this.vacbot.on('Error', (err: string) => {
        this.log.error(`Vacbot error: ${err}`);
      });

      try {
        this.setupEventHandlers();

        // Create and register the Matter endpoint only once — reconnects reuse it.
        if (this.rvc === null) {
          const rooms = await this.fetchSpotAreas();
          await this.createRvcDevice(rooms);
        }

        this.pollState();

        // Keepalive: re-poll state every 90 s to keep Matter subscriptions alive.
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
          if (!this.vacbot) return;
          try {
            this.pollState();
          } catch (err: unknown) {
            this.log.debug(`Keepalive poll error (MQTT may be reconnecting): ${String(err)}`);
          }
        }, KEEPALIVE_INTERVAL_MS);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to set up Matter device: ${message}`);
      }
    });

    this.vacbot.connect();
  }

  /**
   * Tear down the vacbot connection (timers, MQTT). The Matter endpoint is kept
   * so a subsequent attach() reuses it.
   */
  async detach(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.vacbot) {
      try {
        await this.vacbot.disconnectAsync();
      } catch {
        this.vacbot.disconnect();
      }
      this.vacbot = null;
    }
  }

  /**
   * Poll the robot state, using the clean-state command variant the firmware
   * accepts. Polling matters even though the robot pushes CleanReport events:
   * a dropped MQTT message would otherwise leave the Matter state stale until
   * the next state change.
   */
  private pollState(): void {
    this.vacbot.run('GetBatteryState');
    this.vacbot.run('GetChargeState');
    if (this.definition.cleanStatePoll !== 'none') {
      this.vacbot.run(this.definition.cleanStatePoll);
    }
  }

  // ── Spot area discovery ─────────────────────────────────────────────────────

  /**
   * Fetch the list of named rooms/spot-areas from the robot's saved map.
   * Resolves with whatever rooms arrived within 10 s (may be empty on timeout).
   *
   * @returns {Promise<SpotRoom[]>} Array of spot rooms from the robot map.
   */
  private fetchSpotAreas(): Promise<SpotRoom[]> {
    return new Promise((resolve) => {
      const rooms: SpotRoom[] = [];
      let mapMID: string | null = null;
      let pendingAreas = 0;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // vacbot does not expose .off() — the finished flag prevents double-resolve,
        // and once() handlers for CurrentMapMID / MapSpotAreas auto-remove after first fire.
        this.log.info(`Discovered ${rooms.length} room(s): ${rooms.map((r) => r.name).join(', ') || '(none)'}`);
        resolve(rooms);
      };

      const timer = setTimeout(() => {
        this.log.warn(`fetchSpotAreas timed out — continuing with ${rooms.length} room(s) found so far`);
        finish();
      }, 10_000);

      const onCurrentMapMID = (mid: string) => {
        if (mapMID !== null) return; // use only the first map
        mapMID = mid;
        this.log.debug(`fetchSpotAreas: map MID = ${mid}`);
        this.vacbot.run('GetSpotAreas', mid);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onMapSpotAreas = (spotAreas: any) => {
        if (finished) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const areas: any[] = spotAreas?.mapSpotAreas ?? [];
        if (areas.length === 0) {
          finish();
          return;
        }
        pendingAreas = areas.length;
        for (const area of areas) {
          this.log.debug(`fetchSpotAreas: requesting info for area ${area.mapSpotAreaID}`);
          this.vacbot.run('GetSpotAreaInfo', mapMID, area.mapSpotAreaID);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onMapSpotAreaInfo = (info: any) => {
        rooms.push({ id: String(info.mapSpotAreaID), name: String(info.mapSpotAreaName) });
        this.log.debug(`fetchSpotAreas: area ${info.mapSpotAreaID} = "${info.mapSpotAreaName}"`);
        pendingAreas--;
        if (pendingAreas <= 0) finish();
      };

      // Use on() not once() — once() may not be exposed on the vacbot wrapper.
      // All handlers are guarded (mapMID !== null / finished) against double-firing.
      this.vacbot.on('CurrentMapMID', onCurrentMapMID);
      this.vacbot.on('MapSpotAreas', onMapSpotAreas);
      this.vacbot.on('MapSpotAreaInfo', onMapSpotAreaInfo);

      this.vacbot.run('GetMaps');
    });
  }

  // ── Event handlers (Ecovacs → Matter) ───────────────────────────────────────

  private setupEventHandlers(): void {
    this.vacbot.on('BatteryInfo', (battery: number) => {
      if (this.rvc === null) return;
      const pct = Math.round(battery);
      const level = pct > 20 ? BAT_CHARGE_LEVEL.Ok : pct > 5 ? BAT_CHARGE_LEVEL.Warning : BAT_CHARGE_LEVEL.Critical;
      this.rvc.setAttribute('powerSource', 'batPercentRemaining', pct * 2, this.log).catch((err: unknown) => {
        this.log.debug(`setAttribute batPercentRemaining error: ${String(err)}`);
      });
      this.rvc.setAttribute('powerSource', 'batChargeLevel', level, this.log).catch((err: unknown) => {
        this.log.debug(`setAttribute batChargeLevel error: ${String(err)}`);
      });
      this.lastBatteryPct = pct;
      // Battery level feeds the resolved state: reaching 100% while charging
      // upgrades to IsAtFullCharge/Docked.
      this.applyState();
      this.log.debug(`Battery: ${pct}% (level=${level})`);
    });

    this.vacbot.on('CleanReport', (status: string) => {
      // 'freeClean' (used by X2 firmware for spot-area commands) is not in ecovacs-deebot's
      // CLEAN_MODE_FROM_ECOVACS dictionary — the library emits CleanReport(undefined).
      // Treat undefined as 'spot_area' so the controller knows the robot is actively cleaning.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: string = (status as any) ?? 'spot_area';
      this.log.info(`CleanReport: ${s}`);

      if (s === 'pause' && this.resumePending) {
        // Resume was sent but the robot's push for the original pause arrived late.
        // The robot is already resuming — discard this stale event.
        this.log.debug('CleanReport: pause ignored — resume already sent');
        this.resumePending = false;
        return;
      }
      if (s !== 'pause') this.resumePending = false;

      this.cleanState = cleanReportToOpState(s);
      this.applyState();
    });

    this.vacbot.on('ChargeState', (status: string) => {
      this.log.info(`ChargeState: ${status}`);
      this.lastChargeStatus = status;
      this.applyState();
    });

    this.vacbot.on('ErrorCode', (code: string) => {
      const rvcError = ECOVACS_TO_RVC_ERROR[code] ?? RVC_ERROR.UnableToCompleteOperation;
      if (rvcError === RVC_ERROR.NoError) {
        this.log.debug(`ErrorCode: ${code} (no error / transient)`);
      } else {
        const desc = ECOVACS_EXTRA_DESCRIPTIONS[code] ?? `errorCode ${code}`;
        this.log.warn(`Ecovacs error ${code}: ${desc}`);
      }
      this.setRvcError(rvcError);
    });
  }

  /**
   * Apply the resolved state after the current Matter transaction has completed.
   *
   * Command handlers run inside a Matter transaction that Matterbridge's own
   * cluster servers also write to; writing attributes synchronously from a
   * handler deadlocks against those writes ([synchronous-transaction-conflict]),
   * which the controller surfaces as "could not complete". Deferring to the next
   * tick lets the command response go out first.
   */
  private scheduleApplyState(): void {
    setImmediate(() => this.applyState());
  }

  /**
   * Resolve the single Matter operational state from the two independent inputs
   * the robot reports: the cleaning task (CleanReport) and the dock (ChargeState).
   *
   * The cleaning side wins whenever the robot is off the dock doing something,
   * because the station reports charging/idle independently of the robot — e.g.
   * it announces `charging` the instant the robot unplugs, which must not
   * overwrite `Running`. Otherwise the dock's view wins, so a finished or
   * stopped task falls back to Charging/Docked rather than a stale Stopped.
   *
   * The one exception is `Paused` while the dock is charging: the robot is home
   * with an interrupted task, not paused mid-floor, so the dock's view is the
   * honest one to show.
   */
  private applyState(): void {
    const cleanSideWins =
      this.cleanState === OP_STATE.Running || this.cleanState === OP_STATE.SeekingCharger || (this.cleanState === OP_STATE.Paused && this.chargeState !== OP_STATE.Charging);

    const resolved = cleanSideWins ? this.cleanState : this.chargeState;
    const runMode = resolved === OP_STATE.Running ? RUN_MODE.Cleaning : RUN_MODE.Idle;

    this.setRvcState(runMode, resolved);
    this.setBatChargeState(this.batChargeState(resolved));
  }

  /**
   * Dock-side operational state, derived from the last ChargeState and battery level.
   *
   * @returns {number} The RVC operational state the dock implies.
   */
  private get chargeState(): number {
    switch (this.lastChargeStatus) {
      case 'returning':
      case 'going':
      case 'goCharging':
        return OP_STATE.SeekingCharger;
      case 'charging':
      case 'slot_charging':
        // At 100% show Docked ("Ready") rather than Charging, which controllers
        // otherwise display indefinitely.
        return this.lastBatteryPct >= 100 ? OP_STATE.Docked : OP_STATE.Charging;
      default:
        // 'idle' — robot is off the dock and not cleaning.
        return OP_STATE.Docked;
    }
  }

  /**
   * PowerSource batChargeState for the resolved operational state. Derived from
   * the resolved state rather than the raw charge status so a dock that reports
   * charging while the robot is away cleaning cannot claim the battery is
   * charging.
   *
   * @param {number} resolved - The resolved RVC operational state.
   * @returns {number} The batChargeState value to report.
   */
  private batChargeState(resolved: number): number {
    if (resolved === OP_STATE.Charging) return BAT_CHARGE_STATE.IsCharging;
    const docked = resolved === OP_STATE.Docked;
    const charging = this.lastChargeStatus === 'charging' || this.lastChargeStatus === 'slot_charging';
    if (docked && charging && this.lastBatteryPct >= 100) return BAT_CHARGE_STATE.IsAtFullCharge;
    return BAT_CHARGE_STATE.IsNotCharging;
  }

  /** Emit the RVC OperationCompletion event so controllers refresh promptly. */
  private triggerOperationCompletion(): void {
    if (this.rvc === null) return;
    this.log.info('Cleaning run ended — triggering operationCompletion');
    this.rvc.triggerEvent('rvcOperationalState', 'operationCompletion', { completionErrorCode: RVC_ERROR.NoError }, this.log).catch((err: unknown) => {
      this.log.debug(`triggerEvent operationCompletion error: ${String(err)}`);
    });
  }

  private setRvcState(runMode: number, opState: number): void {
    if (this.rvc === null) return;
    if (runMode !== this.lastRunMode || opState !== this.lastOpState) {
      this.log.info(`RVC state → runMode=${runMode} opState=0x${opState.toString(16).padStart(2, '0')}`);
    }
    if (runMode !== this.lastRunMode) {
      this.lastRunMode = runMode;
      this.rvc.setAttribute('rvcRunMode', 'currentMode', runMode, this.log).catch((err: unknown) => {
        this.log.debug(`setAttribute rvcRunMode.currentMode error: ${String(err)}`);
      });
    }
    if (opState !== this.lastOpState) {
      this.lastOpState = opState;
      this.rvc.setAttribute('rvcOperationalState', 'operationalState', opState, this.log).catch((err: unknown) => {
        this.log.debug(`setAttribute rvcOperationalState.operationalState error: ${String(err)}`);
      });
    }
  }

  private setRvcError(errorId: number): void {
    if (this.rvc === null) return;
    if (errorId === this.lastErrorId) return;
    this.lastErrorId = errorId;
    this.rvc.setAttribute('rvcOperationalState', 'operationalError', { errorStateId: errorId }, this.log).catch((err: unknown) => {
      this.log.debug(`setAttribute rvcOperationalState.operationalError error: ${String(err)}`);
    });
  }

  private setBatChargeState(state: number): void {
    if (this.rvc === null) return;
    if (state === this.lastBatChargeState) return;
    this.lastBatChargeState = state;
    this.rvc.setAttribute('powerSource', 'batChargeState', state, this.log).catch((err: unknown) => {
      this.log.debug(`setAttribute powerSource.batChargeState error: ${String(err)}`);
    });
  }

  // ── Matter device creation ──────────────────────────────────────────────────

  private async createRvcDevice(rooms: SpotRoom[]): Promise<void> {
    // Build Matter ServiceArea list from the Ecovacs spot areas.
    // areaId is 1-based; spotAreaMap translates back to Ecovacs IDs at clean time.
    this.spotAreaMap.clear();
    const supportedAreas = rooms.map((room, index) => {
      const areaId = index + 1;
      this.spotAreaMap.set(areaId, room.id);
      return {
        areaId,
        mapId: null,
        areaInfo: {
          locationInfo: { locationName: room.name, floorNumber: null as number | null, areaType: null as number | null },
          landmarkInfo: null,
        },
      };
    });

    this.rvc = new RoboticVacuumCleaner(
      this.name,
      this.vacuum.did,
      'server',
      undefined, // currentRunMode (default: Idle)
      undefined, // supportedRunModes (default: Idle/Cleaning/Mapping/SpotCleaning)
      this.currentCleanMode, // currentCleanMode
      buildSupportedCleanModes(this.definition),
      undefined, // currentPhase
      undefined, // phaseList
      undefined, // operationalState (default: Docked)
      undefined, // operationalStateList (default: full list)
      supportedAreas.length > 0 ? supportedAreas : undefined, // real rooms or Matterbridge defaults
      [], // selectedAreas
    );

    // ── Command handlers (Matter → Ecovacs) ────────────────────────────────────

    // selectAreas — remember which rooms the controller wants to clean
    this.rvc.addCommandHandler('selectAreas', async (data) => {
      const newAreas: number[] = (data.request as { newAreas: number[] }).newAreas;
      this.selectedAreaIds = newAreas;
      this.log.info(`Matter command: selectAreas → [${newAreas.join(', ')}]`);
    });

    // pause / resume / goHome come from RvcOperationalState cluster
    this.rvc.addCommandHandler('pause', async () => {
      this.log.info('Matter command: pause');
      this.cleanState = OP_STATE.Paused;
      // An explicit pause supersedes any in-flight resume, so a pause the robot
      // pushes from here on is genuine and must not be discarded as stale.
      this.resumePending = false;
      this.scheduleApplyState();
      this.pauseResumeClean('pause');
    });

    this.rvc.addCommandHandler('resume', async () => {
      this.log.info('Matter command: resume');
      this.cleanState = OP_STATE.Running;
      this.resumePending = true;
      this.scheduleApplyState();
      this.pauseResumeClean('resume');
    });

    this.rvc.addCommandHandler('goHome', async () => {
      this.log.info('Matter command: goHome');
      this.cleanState = OP_STATE.SeekingCharger;
      this.resumePending = false;
      this.scheduleApplyState();
      // End the job before docking: charge() alone only pauses an active V2 job,
      // leaving it "paused" in the Ecovacs app forever. (Verified live on the X2 —
      // the old advice to avoid stop-before-charge was based on the non-V2 stop,
      // which V2 firmware ignores; the pausing was caused by charge() itself.)
      if (this.vacbot) {
        this.stopClean();
        this.vacbot.charge();
      }
    });

    // identify — mandatory Matter cluster; Ecovacs robots have no identify function so just log
    this.rvc.addCommandHandler('identify', async (data) => {
      const seconds = (data.request as { identifyTime: number }).identifyTime;
      this.log.info(`Matter command: identify (${seconds}s)`);
    });

    // changeToMode is shared between RvcRunMode and RvcCleanMode clusters.
    // Distinguish by data.cluster: 'rvcRunMode' vs 'rvcCleanMode'.
    this.rvc.addCommandHandler('changeToMode', async (data) => {
      const newMode: number = (data.request as { newMode: number }).newMode;
      const cluster: string = data.cluster ?? '';

      if (cluster.toLowerCase().includes('runmode') || cluster.toLowerCase().includes('run_mode')) {
        this.log.info(`Matter command: changeToMode (RunMode) → ${newMode}`);
        if (newMode === RUN_MODE.Idle) {
          if (this.vacbot) this.stopClean();
        } else if (this.isRobotPaused) {
          // HomeKit sends SpotCleaning(4) as a resume-after-pause signal; honour it.
          this.log.info('Resuming paused clean');
          this.cleanState = OP_STATE.Running;
          this.resumePending = true;
          this.scheduleApplyState();
          this.pauseResumeClean('resume');
        } else {
          // Any other non-Idle mode (Cleaning=2, SpotCleaning=4, etc.) → start clean
          this.startClean();
        }
      } else {
        // Clean mode changed — store for next clean, do not start
        this.log.info(`Matter command: changeToMode (CleanMode) → ${newMode}`);
        if (this.speedLevelMap.has(newMode)) {
          // Speed/intensity mode (10+)
          this.currentSpeedMode = newMode;
        } else {
          // Cleaning type mode (Vacuum/Mop/etc. at 1-4)
          this.currentCleanMode = newMode;
        }
      }
    });

    await this.platform.registerDevice(this.rvc);
    this.log.info(`${this.name} registered as Matter RVC device with ${supportedAreas.length} room(s)`);
  }

  // ── Cleaning commands ───────────────────────────────────────────────────────

  /**
   * Pin the robot's cleaning type to the currently selected Matter clean mode
   * before starting a clean, on models that support `setWorkMode`.
   *
   * Always sent (even for vacuum-only) so state left behind by the Ecovacs app
   * — e.g. mopping enabled from a previous run — can never leak into a
   * HomeKit-initiated clean. Verified live on an X2 Omni: `setWorkMode` is
   * side-effect-free at the dock, whereas `setSweepMode` (which is a
   * scrubbing-style toggle, not the vacuum/mop selector) triggers a mop-pad
   * wash merely by being sent.
   */
  /**
   * Stop the current cleaning job with the command variant the firmware accepts.
   * V2-generation robots ignore the library's non-V2 stop (`clean` act=stop);
   * they need `clean_V2` act=stop — verified live on the X2, which answers with
   * a CleanReport: idle push and ends the job in the Ecovacs app.
   */
  private stopClean(): void {
    if (this.definition.cleanCommand === 'Clean_V2') {
      this.log.info('Stopping clean (clean_V2 act=stop)');
      this.vacbot.run('Generic', 'clean_V2', { act: 'stop', content: { type: '' } });
    } else {
      this.log.info('Stopping clean (stop)');
      this.vacbot.stop();
    }
  }

  /**
   * Pause or resume the current job with the command variant the firmware accepts.
   * As with stop, V2-generation robots ignore the library's non-V2 `clean`
   * act=pause/resume — the X2 needs `clean_V2`.
   *
   * @param {'pause' | 'resume'} act - Which action to send.
   */
  private pauseResumeClean(act: 'pause' | 'resume'): void {
    if (!this.vacbot) return;
    if (this.definition.cleanCommand === 'Clean_V2') {
      this.log.info(`Sending ${act} (clean_V2 act=${act})`);
      this.vacbot.run('Generic', 'clean_V2', { act, content: { type: '' } });
    } else if (act === 'pause') {
      this.vacbot.pause();
    } else {
      this.vacbot.resume();
    }
  }

  private applyWorkMode(): void {
    if (this.definition.cleanTypeStrategy !== 'workMode') return;
    const key = (Object.keys(CLEAN_MODE_NUMBER) as CleanModeKey[]).find((k) => CLEAN_MODE_NUMBER[k] === this.currentCleanMode) ?? 'vacuum';
    const mode = ECOVACS_WORK_MODE[key];
    this.log.info(`Setting work mode: ${key} (setWorkMode ${mode})`);
    this.vacbot.run('Generic', 'setWorkMode', { mode });
  }

  private startClean(): void {
    if (!this.vacbot) return;
    // Report Running straight away; the robot confirms via CleanReport. Deferred
    // because startClean runs inside the changeToMode command transaction.
    this.cleanState = OP_STATE.Running;
    this.scheduleApplyState();

    // Apply suction intensity if a speed mode has been selected.
    if (this.currentSpeedMode !== null) {
      const level = this.speedLevelMap.get(this.currentSpeedMode);
      if (level !== undefined) this.vacbot.run('SetCleanSpeed', level);
    }

    // If specific areas are selected in the controller, clean only those rooms.
    if (this.selectedAreaIds.length > 0 && this.definition.spotAreaStrategy !== 'none') {
      const ecovacsIds = this.selectedAreaIds.map((id) => this.spotAreaMap.get(id)).filter(Boolean) as string[];
      if (ecovacsIds.length > 0) {
        this.applyWorkMode();
        this.startSpotAreaClean(ecovacsIds);
        return;
      }
    }

    // Full-house clean based on current clean mode.
    // NOTE: vacbot.clean() sends the non-V2 'Clean' command which 950-type robots ignore —
    // the model definition selects the command variant the firmware accepts.
    this.applyWorkMode();
    this.log.info(`Starting full clean (${this.definition.cleanCommand})`);
    this.vacbot.run(this.definition.cleanCommand);
  }

  /**
   * Start a clean restricted to the given Ecovacs spot area IDs, using the
   * command variant declared by the model definition.
   *
   * @param {string[]} ecovacsIds - Ecovacs spot area IDs to clean.
   */
  private startSpotAreaClean(ecovacsIds: string[]): void {
    switch (this.definition.spotAreaStrategy) {
      case 'freeClean': {
        // freeClean value format: "cleanings,areaId" per room, separated by semicolons.
        // e.g. area 3 once → "1,3"; areas 3 and 5 once each → "1,3;1,5"
        // (Captured from real X2 app traffic; SpotArea_V2 / type='spotArea' is rejected by X2.)
        const value = ecovacsIds.map((id) => `1,${id}`).join(';');
        this.log.info(`Starting spot area clean (freeClean): areas=[${ecovacsIds.join(',')}] value="${value}"`);
        this.vacbot.run('Generic', 'clean_V2', {
          act: 'start',
          content: { count: 1, donotClean: '', type: 'freeClean', value },
          mode: '',
          router: 'plan',
        });
        break;
      }
      case 'SpotArea_V2':
        this.log.info(`Starting spot area clean (SpotArea_V2): areas=[${ecovacsIds.join(',')}]`);
        this.vacbot.run('SpotArea_V2', ecovacsIds.join(','), 1);
        break;
      case 'SpotArea':
      default:
        this.log.info(`Starting spot area clean (SpotArea): areas=[${ecovacsIds.join(',')}]`);
        this.vacbot.run('SpotArea', 'start', ecovacsIds.join(','));
        break;
    }
  }
}
