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
 * Milliseconds to let a command settle before sending one that depends on it.
 *
 * The Ecovacs commands are fire-and-forget, and the robot applies them
 * asynchronously. Verified live: `setWorkMode` immediately followed by a clean
 * starts the job under the *previous* work mode (a vacuum-only clean then
 * washes the mop pad), and `charge` immediately after a stop is dropped, so the
 * robot stops mid-floor instead of returning to the dock.
 */
const COMMAND_SETTLE_MS = 1_500;

/**
 * How long to wait for the robot to report which room it is in before assuming
 * it has arrived. Only a fallback: models that report their position drive the
 * area directly, which is what makes "travelling" accurate.
 */
const AREA_FALLBACK_MS = 90_000;

/**
 * Resolve after the given delay.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} A promise resolved after the delay.
 */
function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Derive a stable Matter area ID from an Ecovacs spot area ID.
 *
 * Ecovacs area IDs are small numeric strings tied to the robot's saved map, so
 * they map directly (offset by one, since Matter area IDs start at 1). Anything
 * unparseable falls back to the discovery position.
 *
 * @param {string} ecovacsId - The Ecovacs spot area ID.
 * @param {number} index - Position in the discovered list, used as a fallback.
 * @returns {number} The Matter area ID.
 */
function matterAreaId(ecovacsId: string, index: number): number {
  const parsed = Number(ecovacsId);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed + 1 : index + 1;
}

/**
 * Map an Ecovacs CleanReport value to the cleaning-side operational state.
 *
 * `Stopped` means "the robot is not running a task" and defers to the dock's
 * view in {@link VacuumDevice.applyState}.
 *
 * Returns null for the station's own activities ('washing', 'drying',
 * 'airdrying'), which are not robot state transitions at all: a mop-pad wash
 * happens both at the start of a job (before the robot departs) and after one,
 * so letting it change the state makes a freshly started clean flip to
 * Charging for the ~2 minutes the wash takes.
 *
 * @param {string} value - The CleanReport value pushed by the robot.
 * @returns {number | null} The matching RVC operational state, or null to leave the state unchanged.
 */
function cleanReportToOpState(value: string): number | null {
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
    case 'washing':
    case 'drying':
    case 'airdrying':
      return null;
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

  /**
   * Run mode the controller last asked for when starting a clean (Cleaning or
   * SpotCleaning). Reported back while the robot runs, because a controller
   * that asked for SpotCleaning and is told the robot is in Cleaning may treat
   * its request as not having taken effect.
   */
  private activeRunMode: number = RUN_MODE.Cleaning;

  /** Settle time between dependent commands; overridable so tests need no timers. */
  private commandSettleMs: number = COMMAND_SETTLE_MS;

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

  /**
   * Drop the cached view of what the endpoint currently reports.
   *
   * The de-duplication below compares against the last value written; a new
   * endpoint starts from its own defaults, so without this the first update
   * after a rebuild would be skipped as redundant.
   */
  private resetReportedState(): void {
    this.lastRunMode = -1;
    this.lastOpState = -1;
    this.lastErrorId = -1;
    this.lastBatChargeState = -1;
    this.lastCurrentArea = undefined;
  }

  /** Pending fallback that assumes arrival when the robot reports no position */
  private areaFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Last-written ServiceArea currentArea — used to skip redundant setAttribute calls */
  private lastCurrentArea: number | null | undefined = undefined;

  /** Last-written RVC state values — used to skip redundant setAttribute calls */
  private lastRunMode: number = -1;
  private lastOpState: number = -1;
  private lastErrorId: number = -1;
  private lastBatChargeState: number = -1;
  /** Last known battery percentage — used to determine IsAtFullCharge */
  private lastBatteryPct: number = 0;

  /** Tail of the serialised endpoint writes; see {@link enqueueWrite}. */
  private writeQueue: Promise<void> = Promise.resolve();

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
   * Whether the Matter endpoint is present and usable.
   *
   * Matterbridge destroys endpoints when a plugin is restarted or updated, but
   * the robot keeps pushing events, so a stale reference means every update
   * fails with "endpoint is in the inactive state". Treating a dead endpoint as
   * absent lets the next connection build a fresh one instead.
   *
   * @returns {RoboticVacuumCleaner | null} The endpoint, or null when it cannot be written to.
   */
  private get liveRvc(): RoboticVacuumCleaner | null {
    return this.rvc !== null && this.rvc.construction.status === 'active' ? this.rvc : null;
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

        // Reconnects reuse the endpoint, but a plugin restart or update destroys
        // it — rebuild in that case, otherwise the robot silently never appears.
        if (this.liveRvc === null) {
          if (this.rvc !== null) {
            this.log.info('Matter endpoint is no longer active — rebuilding it');
            this.rvc = null;
            this.resetReportedState();
          }
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
    this.clearAreaFallback();
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
      const rvc = this.liveRvc;
      if (rvc === null) return;
      const pct = Math.round(battery);
      const level = pct > 20 ? BAT_CHARGE_LEVEL.Ok : pct > 5 ? BAT_CHARGE_LEVEL.Warning : BAT_CHARGE_LEVEL.Critical;
      this.writeAttribute('powerSource', 'batPercentRemaining', pct * 2);
      this.writeAttribute('powerSource', 'batChargeLevel', level);
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

      const cleanState = cleanReportToOpState(s);
      if (cleanState === null) return; // station activity — not a robot state change
      this.cleanState = cleanState;
      this.applyState();
    });

    this.vacbot.on('ChargeState', (status: string) => {
      this.log.info(`ChargeState: ${status}`);
      this.lastChargeStatus = status;
      this.applyState();
    });

    this.vacbot.on('DeebotPosition', (position: { currentSpotAreaID?: string }) => {
      // The library derives the room from the robot's coordinates; this is what
      // tells us it has stopped travelling and started cleaning the room.
      const id = position?.currentSpotAreaID;
      if (!id || id === 'unknown') return;
      this.reportAreaFromEcovacsId(id);
    });

    this.vacbot.on('CurrentSpotAreas', (areas: string) => {
      // The robot reports which Ecovacs spot area it is in; translate to the
      // Matter area so the controller can tell cleaning from travelling.
      const ecovacsId = String(areas ?? '')
        .split(',')[0]
        ?.trim();
      if (ecovacsId) this.reportAreaFromEcovacsId(ecovacsId);
    });

    this.vacbot.on('ErrorCode', (code: string) => {
      // ecovacs-deebot reports its own internal failures with negative codes
      // (e.g. -2 "Unhandled error"). Those are not robot faults, and surfacing
      // them puts the Matter device into Error, which controllers show as an
      // alert on an otherwise healthy vacuum.
      if (Number(code) < 0) {
        this.log.debug(`Ignoring library-internal error code ${code}`);
        return;
      }
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
   * Run an endpoint write, one at a time.
   *
   * Each write opens its own Matter transaction and locks the cluster's state
   * for as long as it runs. Matterbridge's own pause/resume/goHome handlers set
   * RvcRunMode.currentMode *synchronously* inside the command invocation, and a
   * synchronous lock request throws outright rather than waiting — so a lock
   * still held by one of our writes fails the whole command, which the
   * controller reports as "could not complete".
   *
   * A single state change used to fire up to six writes at once (run mode,
   * operational state, serviced area, charge state, battery level and
   * percentage), and the robot pushes one roughly every second while it works,
   * so the locks were held far more often than the writes themselves take.
   * Queueing them narrows that to one short write at a time.
   *
   * This cannot close the window completely — a command can always arrive
   * during the one write still in flight. Matterbridge acquiring those locks
   * asynchronously is the only complete fix, and that is its call to make.
   *
   * @param {string} label - Identifies the write in error logs.
   * @param {() => Promise<unknown>} op - The write to run.
   */
  private enqueueWrite(label: string, op: () => Promise<unknown>): void {
    const previous = this.writeQueue;
    this.writeQueue = (async () => {
      await previous;
      try {
        await op();
      } catch (err: unknown) {
        // Swallowed deliberately: one failed write must not stall the queue.
        this.log.debug(`${label} error: ${String(err)}`);
      }
    })();
  }

  /**
   * Queue an attribute write.
   *
   * @param {string} cluster - The cluster to write to.
   * @param {string} attribute - The attribute to write.
   * @param {string | number | bigint | boolean | object | null} value - The value to write.
   */
  private writeAttribute(cluster: string, attribute: string, value: string | number | bigint | boolean | object | null): void {
    const rvc = this.liveRvc;
    if (rvc === null) return;
    this.enqueueWrite(`setAttribute ${cluster}.${attribute}`, () => rvc.setAttribute(cluster, attribute, value, this.log));
  }

  /**
   * Resolve once every queued write has finished and the endpoint is quiescent.
   *
   * Writes are deliberately not awaited by the push handlers that trigger them,
   * so this is the only way to know they have landed — tests need it to drive a
   * command without racing the writes from the state they just set up.
   *
   * @returns {Promise<void>} Resolves when no write is outstanding.
   */
  async whenWritesSettled(): Promise<void> {
    // Awaiting the tail can queue more writes behind it, so keep going until the
    // queue stops growing.
    let tail: Promise<void>;
    do {
      tail = this.writeQueue;
      await tail;
    } while (tail !== this.writeQueue);
  }

  /**
   * Run a command sequence in the background.
   *
   * Sequences that wait for a command to settle must not block the handler:
   * Matterbridge applies its own cluster state only after the handler resolves,
   * so awaiting here delays the command response and lets our state write land
   * before Matterbridge's, leaving the two fighting over the attribute.
   *
   * @param {() => Promise<void>} sequence - The command sequence to run.
   */
  private runInBackground(sequence: () => Promise<void>): void {
    sequence().catch((err: unknown) => {
      this.log.error(`Ecovacs command sequence failed: ${String(err)}`);
    });
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
    const runMode = resolved === OP_STATE.Running ? this.activeRunMode : RUN_MODE.Idle;

    this.setRvcState(runMode, resolved);
    this.setBatChargeState(this.batChargeState());
    if (resolved !== OP_STATE.Running) this.setCurrentArea(null);
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
   * PowerSource batChargeState, following the dock's own report. Deriving it
   * from the resolved operational state instead makes it flap between charging
   * and not-charging while a job starts, since the dock keeps reporting
   * `charging` until the robot has actually left it.
   *
   * @returns {number} The batChargeState value to report.
   */
  private batChargeState(): number {
    const charging = this.lastChargeStatus === 'charging' || this.lastChargeStatus === 'slot_charging';
    if (!charging) return BAT_CHARGE_STATE.IsNotCharging;
    return this.lastBatteryPct >= 100 ? BAT_CHARGE_STATE.IsAtFullCharge : BAT_CHARGE_STATE.IsCharging;
  }

  /** Emit the RVC OperationCompletion event so controllers refresh promptly. */
  private triggerOperationCompletion(): void {
    if (this.rvc === null) return;
    this.log.info('Cleaning run ended — triggering operationCompletion');
    const rvc = this.rvc;
    this.enqueueWrite('triggerEvent operationCompletion', () =>
      rvc.triggerEvent('rvcOperationalState', 'operationCompletion', { completionErrorCode: RVC_ERROR.NoError }, this.log),
    );
  }

  private setRvcState(runMode: number, opState: number): void {
    const rvc = this.liveRvc;
    if (rvc === null) return;
    if (runMode !== this.lastRunMode || opState !== this.lastOpState) {
      this.log.info(`RVC state → runMode=${runMode} opState=0x${opState.toString(16).padStart(2, '0')}`);
    }
    if (runMode !== this.lastRunMode) {
      this.lastRunMode = runMode;
      this.writeAttribute('rvcRunMode', 'currentMode', runMode);
    }
    if (opState !== this.lastOpState) {
      this.lastOpState = opState;
      this.writeAttribute('rvcOperationalState', 'operationalState', opState);
    }
  }

  /**
   * Report which area the robot is servicing.
   *
   * Controllers compare this with SelectedAreas to decide whether the robot is
   * cleaning the requested room or still on its way: Apple Home shows
   * "travelling to room" for as long as CurrentArea is not the selected one, so
   * leaving it at its default made a room clean never display as cleaning.
   *
   * @param {number | null} areaId - The Matter area being serviced, or null when none.
   */
  private setCurrentArea(areaId: number | null): void {
    const rvc = this.liveRvc;
    if (rvc === null || areaId === this.lastCurrentArea) return;
    this.lastCurrentArea = areaId;
    this.log.info(`ServiceArea currentArea → ${areaId ?? 'null'}`);
    this.writeAttribute('serviceArea', 'currentArea', areaId);
  }

  /**
   * Report the area matching an Ecovacs spot area ID, if we know it.
   *
   * @param {string} ecovacsId - The Ecovacs spot area the robot reports being in.
   */
  private reportAreaFromEcovacsId(ecovacsId: string): void {
    for (const [matterId, id] of this.spotAreaMap) {
      if (id === ecovacsId) {
        this.clearAreaFallback();
        this.setCurrentArea(matterId);
        return;
      }
    }
  }

  /**
   * Assume the robot reached the requested room if it never reports a position.
   *
   * Position reporting depends on the robot having usable map data; without this
   * a clean would sit on "travelling" for its whole duration on models that stay
   * quiet.
   */
  private startAreaFallback(): void {
    this.clearAreaFallback();
    const target = this.selectedAreaIds[0];
    if (target === undefined) return;
    this.areaFallbackTimer = setTimeout(() => {
      this.areaFallbackTimer = null;
      if (this.cleanState !== OP_STATE.Running || this.lastCurrentArea !== null) return;
      this.log.debug(`No position reported after ${AREA_FALLBACK_MS / 1000}s — assuming the robot reached area ${target}`);
      this.setCurrentArea(target);
    }, AREA_FALLBACK_MS);
  }

  private clearAreaFallback(): void {
    if (this.areaFallbackTimer) {
      clearTimeout(this.areaFallbackTimer);
      this.areaFallbackTimer = null;
    }
  }

  private setRvcError(errorId: number): void {
    const rvc = this.liveRvc;
    if (rvc === null) return;
    if (errorId === this.lastErrorId) return;
    this.lastErrorId = errorId;
    this.writeAttribute('rvcOperationalState', 'operationalError', { errorStateId: errorId });
  }

  private setBatChargeState(state: number): void {
    const rvc = this.liveRvc;
    if (rvc === null) return;
    if (state === this.lastBatChargeState) return;
    this.lastBatChargeState = state;
    this.writeAttribute('powerSource', 'batChargeState', state);
  }

  // ── Matter device creation ──────────────────────────────────────────────────

  private async createRvcDevice(rooms: SpotRoom[]): Promise<void> {
    // Build Matter ServiceArea list from the Ecovacs spot areas.
    // areaId is 1-based; spotAreaMap translates back to Ecovacs IDs at clean time.
    this.spotAreaMap.clear();
    const supportedAreas = rooms.map((room, index) => {
      // Derive the Matter area ID from the Ecovacs one so it survives restarts.
      // Numbering by discovery order instead is a race: room details arrive as
      // separate pushes, so the same room can land at a different index on the
      // next run — observed live, where one HomeKit area meant two different
      // rooms across restarts, silently re-pointing saved selections.
      const areaId = matterAreaId(room.id, index);
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
      // currentArea must name one of the supported areas: the cluster refuses to
      // initialise otherwise, and Matterbridge's default of 1 is not a valid area
      // once IDs come from the robot's own numbering (which need not start at 0).
      supportedAreas[0]?.areaId,
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
        this.runInBackground(async () => {
          this.stopClean();
          // Let the stop settle: a charge sent immediately after it is dropped
          // and the robot stays where it is.
          await delay(this.commandSettleMs);
          this.vacbot?.charge();
        });
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
          // Any other non-Idle mode (Cleaning=2, SpotCleaning=4, etc.) → start clean,
          // reporting back the mode the controller asked for.
          this.activeRunMode = newMode;
          this.runInBackground(() => this.startClean());
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

  private async startClean(): Promise<void> {
    if (!this.vacbot) return;
    // Until the robot reports which room it is in, it is on its way there.
    // Controllers use exactly this to tell travelling from cleaning.
    this.setCurrentArea(null);
    this.startAreaFallback();
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
        await delay(this.commandSettleMs);
        this.startSpotAreaClean(ecovacsIds);
        return;
      }
    }

    // Full-house clean based on current clean mode.
    // NOTE: vacbot.clean() sends the non-V2 'Clean' command which 950-type robots ignore —
    // the model definition selects the command variant the firmware accepts.
    this.applyWorkMode();
    await delay(this.commandSettleMs);
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
