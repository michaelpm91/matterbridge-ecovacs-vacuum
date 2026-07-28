/**
 * Matter numeric constants, Ecovacs → Matter mappings, and helpers for building
 * the RVC clean mode list from a model definition.
 *
 * @file constants.ts
 * @license Apache-2.0
 */

import type { CleanModeKey, CleanSpeedTag, ModelDefinition } from './models/types.js';

// ── Ecovacs country code remapping ───────────────────────────────────────────
// Ecovacs uses non-standard country codes for some countries.
// Source: deebot_client/util/countries.py in the deebot-client Python library.
const ECOVACS_COUNTRY_MAP: Record<string, string> = {
  GB: 'UK',
};

/**
 * Map an ISO alpha-2 country code to the country code expected by the Ecovacs API.
 * Ecovacs does not expose endpoints for every ISO code (e.g. GB → UK).
 *
 * @param {string} country - ISO alpha-2 country code from plugin config.
 * @returns {string} The Ecovacs-specific country code string.
 */
export function toEcovacsCountry(country: string): string {
  const upper = country.toUpperCase();
  return ECOVACS_COUNTRY_MAP[upper] ?? upper;
}

// ── Matter mode/state numeric constants ──────────────────────────────────────

/** RVC Run Mode cluster: supported mode numbers */
export const RUN_MODE = {
  Idle: 1,
  Cleaning: 2,
} as const;

/** RVC Operational State cluster: state IDs */
export const OP_STATE = {
  Stopped: 0x00,
  Running: 0x01,
  Paused: 0x02,
  SeekingCharger: 0x40,
  Charging: 0x41,
  Docked: 0x42,
} as const;

/**
 * RVC Operational State cluster: error IDs (Matter spec §8.2 + RVC profile §9.3).
 * These are reported via the `operationalError` attribute.
 */
export const RVC_ERROR = {
  NoError: 0x00,
  UnableToStartOrResume: 0x01,
  UnableToCompleteOperation: 0x02,
  Stuck: 0x41,
  DustBinMissing: 0x42,
  DustBinFull: 0x43,
  WaterTankEmpty: 0x44,
  WaterTankMissing: 0x45,
  WaterTankLidOpen: 0x46,
  MopCleaningPadMissing: 0x47,
} as const;

/**
 * Map Ecovacs error codes to RVC error IDs.
 * Codes not in this table default to UnableToCompleteOperation.
 * Includes codes not yet in the ecovacs-deebot errorCodes.json (e.g. X2-specific).
 */
export const ECOVACS_TO_RVC_ERROR: Record<string, number> = {
  '0': RVC_ERROR.NoError,
  '100': RVC_ERROR.NoError,
  '102': RVC_ERROR.UnableToStartOrResume, // off floor
  '103': RVC_ERROR.UnableToStartOrResume, // wheel malfunction
  '104': RVC_ERROR.UnableToStartOrResume, // anti-drop sensor
  '105': RVC_ERROR.Stuck,
  '108': RVC_ERROR.Stuck, // side brush tangled
  '109': RVC_ERROR.Stuck, // main brush tangled
  '110': RVC_ERROR.DustBinMissing,
  '111': RVC_ERROR.Stuck, // bump sensor stuck
  '114': RVC_ERROR.DustBinFull,
  '120': RVC_ERROR.WaterTankEmpty, // water box error
  '301': RVC_ERROR.WaterTankEmpty, // FreshWaterBox empty
  '302': RVC_ERROR.DustBinFull, // WasteWaterBox full
  '303': RVC_ERROR.WaterTankMissing, // FreshWaterBox missing
  '304': RVC_ERROR.WaterTankMissing, // WasteWaterBox missing
  '305': RVC_ERROR.DustBinFull, // Dirty Water Tank full
  '310': RVC_ERROR.WaterTankLidOpen, // Lid open
  '311': RVC_ERROR.DustBinFull, // Replace Dust Bag
  '317': RVC_ERROR.WaterTankEmpty, // Clean Water Tank refill malfunction
  '318': RVC_ERROR.DustBinFull, // Dirty Water Tank full
  '322': RVC_ERROR.WaterTankEmpty, // X2-specific: clean water tank needs topping up
  '323': RVC_ERROR.DustBinFull, // X2-specific: dirty water tank full — needs emptying
  '1007': RVC_ERROR.MopCleaningPadMissing, // Mop plugged
};

/**
 * Human-readable descriptions for Ecovacs error codes not in the library's errorCodes.json.
 */
export const ECOVACS_EXTRA_DESCRIPTIONS: Record<string, string> = {
  '322': 'Clean water tank empty — top up required',
  '323': 'Dirty water tank full — empty required',
};

/** PowerSource cluster: BatChargeLevel values */
export const BAT_CHARGE_LEVEL = {
  Ok: 0,
  Warning: 1,
  Critical: 2,
} as const;

/** PowerSource cluster: BatChargeState values */
export const BAT_CHARGE_STATE = {
  Unknown: 0,
  IsCharging: 1,
  IsAtFullCharge: 2,
  IsNotCharging: 3,
} as const;

// ── Clean mode construction ───────────────────────────────────────────────────

/**
 * Matter mode numbers for the cleaning type modes. These are stable across
 * models so HomeKit automations keep working when a model definition changes.
 */
export const CLEAN_MODE_NUMBER: Record<CleanModeKey, number> = {
  vacuum: 1,
  mop: 2,
  vacuumAndMop: 3,
  mopAfterVacuum: 4,
};

/**
 * Map cleaning type modes to Ecovacs `setWorkMode` values (X1/X2 generation).
 * Values verified live on an X2 Omni and against deebot-client's WorkMode enum.
 */
export const ECOVACS_WORK_MODE: Record<CleanModeKey, number> = {
  vacuumAndMop: 0,
  vacuum: 1,
  mop: 2,
  mopAfterVacuum: 3,
};

/** First Matter mode number used for suction speed entries (10, 11, 12, …). */
export const SPEED_MODE_BASE = 10;

/**
 * RvcCleanMode.ModeTag values (Matter spec §7.3.7.2):
 *   General: Auto=0, Quick=1, Quiet=2, Max=7
 *   RVC:     DeepClean=16384, Vacuum=16385, Mop=16386, VacuumThenMop=16387
 */
const MODE_TAG = {
  Auto: 0,
  Quick: 1,
  Quiet: 2,
  Max: 7,
  DeepClean: 16384,
  Vacuum: 16385,
  Mop: 16386,
  VacuumThenMop: 16387,
} as const;

const CLEAN_MODE_LABEL: Record<CleanModeKey, string> = {
  vacuum: 'Vacuum',
  mop: 'Mop',
  vacuumAndMop: 'Vacuum & Mop',
  mopAfterVacuum: 'Mop after Vacuum',
};

/**
 * One tag set per cleaning type.
 *
 * Adding Vacuum+Mop to `mopAfterVacuum` was tried to coax Apple Home into
 * rendering it: it did not make the mode appear, and it broke the speed picker,
 * so the mode keeps only its own tag. Two entries sharing an identical
 * recognised tag set appears to be what confuses the controller's grouping.
 */
const CLEAN_MODE_TAGS: Record<CleanModeKey, number[]> = {
  vacuum: [MODE_TAG.Vacuum],
  mop: [MODE_TAG.Mop],
  vacuumAndMop: [MODE_TAG.Vacuum, MODE_TAG.Mop],
  mopAfterVacuum: [MODE_TAG.VacuumThenMop],
};

// Speed entries carry the Vacuum tag so Apple Home includes them in the type
// context; the intensity tag drives the separate speed picker UI.
const SPEED_TAGS: Record<CleanSpeedTag, number[]> = {
  quiet: [MODE_TAG.Vacuum, MODE_TAG.Quiet],
  auto: [MODE_TAG.Vacuum, MODE_TAG.Auto],
  quick: [MODE_TAG.Vacuum, MODE_TAG.Quick],
  deepClean: [MODE_TAG.DeepClean, MODE_TAG.Vacuum, MODE_TAG.Max],
  max: [MODE_TAG.Vacuum, MODE_TAG.Max],
};

/** One entry of the RvcCleanMode supported modes list. */
export interface RvcCleanModeEntry {
  label: string;
  mode: number;
  modeTags: { value: number }[];
}

/**
 * Build the RvcCleanMode supported modes list for a model.
 *
 * Apple Home renders two separate pickers from this one cluster:
 *   • Type picker  — modes with Vacuum/Mop/VacuumThenMop tags (modes 1-4)
 *   • Speed picker — modes with intensity tags (Quiet/Auto/Quick/Max/DeepClean) (modes 10+)
 *
 * @param {ModelDefinition} definition - The model definition to build from.
 * @returns {RvcCleanModeEntry[]} Supported clean mode entries for the RVC device.
 */
export function buildSupportedCleanModes(definition: ModelDefinition): RvcCleanModeEntry[] {
  const typeModes = definition.cleanModes.map((key) => ({
    label: CLEAN_MODE_LABEL[key],
    mode: CLEAN_MODE_NUMBER[key],
    modeTags: CLEAN_MODE_TAGS[key].map((value) => ({ value })),
  }));
  const speedModes = definition.cleanSpeeds.map((speed, index) => ({
    label: speed.name,
    mode: SPEED_MODE_BASE + index,
    modeTags: SPEED_TAGS[speed.tag].map((value) => ({ value })),
  }));
  return [...typeModes, ...speedModes];
}

/**
 * Build the Matter speed-mode-number → SetCleanSpeed-level lookup for a model.
 *
 * @param {ModelDefinition} definition - The model definition to build from.
 * @returns {Map<number, number>} Map of Matter mode number to ecovacs-deebot speed level.
 */
export function buildSpeedLevelMap(definition: ModelDefinition): Map<number, number> {
  return new Map(definition.cleanSpeeds.map((speed, index) => [SPEED_MODE_BASE + index, speed.level]));
}
