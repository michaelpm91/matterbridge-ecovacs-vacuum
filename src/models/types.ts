/**
 * Type definitions for the vacuum model registry.
 *
 * A model definition declares, per Ecovacs device class, which commands the
 * robot's firmware actually accepts and which quirks apply. The Ecovacs cloud
 * API is inconsistent across generations — commands that work on one model are
 * silently ignored or rejected by another — so everything model-specific is
 * captured declaratively here instead of being hardcoded in the device logic.
 *
 * @file models/types.ts
 * @license Apache-2.0
 */

/** Cleaning type modes exposed to Matter controllers (HomeKit type picker). */
export type CleanModeKey = 'vacuum' | 'mop' | 'vacuumAndMop' | 'mopAfterVacuum';

/**
 * Suction intensity tag. Determines the Matter mode tags used for the entry,
 * which drive how controllers (e.g. Apple Home's speed picker) render it.
 */
export type CleanSpeedTag = 'quiet' | 'auto' | 'quick' | 'deepClean' | 'max';

/**
 * How to start a clean restricted to selected rooms (spot areas):
 * - `freeClean`     — X2-family firmware: `clean_V2` with `type: 'freeClean'` and
 *                     a `"cleanings,areaId;…"` value string (captured from real app
 *                     traffic; the documented SpotArea_V2 command is rejected).
 * - `SpotArea_V2`   — standard 950-type V2 robots.
 * - `SpotArea`      — older non-V2 robots.
 * - `none`          — robot has no room cleaning; selected areas are ignored and a
 *                     full clean is started instead.
 */
export type SpotAreaStrategy = 'freeClean' | 'SpotArea_V2' | 'SpotArea' | 'none';

/** One suction intensity level offered in the Matter clean mode cluster. */
export interface CleanSpeedDefinition {
  /** Label shown in the controller UI, e.g. 'Quiet'. */
  name: string;
  /** ecovacs-deebot SetCleanSpeed level: 1=silent, 2=normal, 3=high, 4=very high. */
  level: number;
  /** Matter mode tag flavour for this speed. */
  tag: CleanSpeedTag;
}

/** Declarative capability description for one vacuum model family. */
export interface ModelDefinition {
  /** Human-readable model family name, used when the account has no nickname for the device. */
  name: string;
  /**
   * Additional Ecovacs device-class IDs that share this definition
   * (equivalent of ecovacs-deebot's `deviceClassLink`).
   */
  aliases?: string[];
  /** Free-form notes for maintainers: verified hardware, firmware quirks, sources. */
  notes?: string;
  /** Command that starts a full-house clean. 950-type V2 robots ignore the plain `Clean` command. */
  cleanCommand: 'Clean' | 'Clean_V2';
  /** How to start a clean restricted to selected rooms. */
  spotAreaStrategy: SpotAreaStrategy;
  /** Robot has a mopping system controllable via EnableSweepMode/DisableSweepMode. */
  supportsMopping: boolean;
  /**
   * Do not send any setSweepMode command on vacuum-only cleans. On all-in-one
   * stations (X2 Omni) sending DisableSweepMode marks mopping as active and
   * triggers an unwanted mop pad wash cycle even for vacuum-only runs.
   */
  skipSweepModeOnVacuumOnly?: boolean;
  /**
   * Firmware rejects GetCleanState polling (X2 responds body.code=20003
   * "rcp not support") and pushes CleanReport events instead. When true the
   * plugin never polls clean state.
   */
  cleanStateIsPushOnly?: boolean;
  /** Cleaning type modes to expose. Order is preserved; the first entry is the default. */
  cleanModes: CleanModeKey[];
  /** Suction intensity levels to expose. Empty array hides the speed picker. */
  cleanSpeeds: CleanSpeedDefinition[];
}
