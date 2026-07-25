/**
 * Ecovacs vacuum model registry.
 *
 * Each entry is keyed by the canonical Ecovacs device class (the `class` field
 * returned by the Ecovacs device-list API) and declares which commands that
 * model family accepts. To add support for a new model, add an entry here —
 * see {@link ModelDefinition} for what each field means — and open a PR.
 *
 * Unknown device classes fall back to {@link DEFAULT_MODEL}, a conservative
 * 950-type V2 profile (vacuum only, standard commands), so unlisted robots
 * still get basic start/stop/dock control.
 *
 * @file models/models.ts
 * @license Apache-2.0
 */

import type { ModelDefinition } from './types.js';

export const MODELS: Record<string, ModelDefinition> = {
  // Deebot X2 family: X2 / X2 Omni / X2 Combo / X2 Pro Omni.
  // Verified on a Deebot X2 Omni via captured app traffic.
  e6ofmn: {
    name: 'Deebot X2',
    aliases: ['lf3bn4', 'e6rcnf', 'ip3mmy', 'p7l7iu'],
    notes:
      'X2 firmware rejects GetCleanState (body.code=20003 "rcp not support") and pushes CleanReport instead. ' +
      'Room cleans must use clean_V2 type=freeClean — SpotArea_V2 is rejected. ' +
      'Cleaning type is selected with setWorkMode (verified live); setSweepMode is a scrubbing toggle, ' +
      'not the vacuum/mop selector, and merely sending it triggers a mop-pad wash at the Omni station.',
    cleanCommand: 'Clean_V2',
    spotAreaStrategy: 'freeClean',
    cleanTypeStrategy: 'workMode',
    cleanStateIsPushOnly: true,
    cleanModes: ['vacuum', 'mop', 'vacuumAndMop', 'mopAfterVacuum'],
    cleanSpeeds: [
      { name: 'Quiet', level: 1, tag: 'quiet' },
      { name: 'Automatic', level: 2, tag: 'auto' },
      { name: 'Quick', level: 3, tag: 'quick' },
      { name: 'Deep Clean', level: 4, tag: 'deepClean' },
    ],
  },
};

/**
 * Conservative fallback profile for device classes not listed in {@link MODELS}:
 * generic 950-type V2 command set, vacuum only, no mop control.
 */
export const DEFAULT_MODEL: ModelDefinition = {
  name: 'Ecovacs Vacuum',
  notes: 'Fallback profile for unrecognised device classes.',
  cleanCommand: 'Clean_V2',
  spotAreaStrategy: 'SpotArea_V2',
  cleanTypeStrategy: 'none',
  cleanStateIsPushOnly: false,
  cleanModes: ['vacuum'],
  cleanSpeeds: [
    { name: 'Quiet', level: 1, tag: 'quiet' },
    { name: 'Automatic', level: 2, tag: 'auto' },
    { name: 'Quick', level: 3, tag: 'quick' },
    { name: 'Max', level: 4, tag: 'max' },
  ],
};

/** Result of a registry lookup. */
export interface ModelResolution {
  definition: ModelDefinition;
  /** False when the device class was not found and {@link DEFAULT_MODEL} was used. */
  matched: boolean;
}

/**
 * Look up the model definition for an Ecovacs device class, resolving aliases.
 *
 * @param {string | undefined} deviceClass - The `class` field from the Ecovacs device-list API.
 * @returns {ModelResolution} The matching definition, or the default profile when unknown.
 */
export function resolveModel(deviceClass: string | undefined): ModelResolution {
  if (deviceClass) {
    const direct = MODELS[deviceClass];
    if (direct) return { definition: direct, matched: true };
    for (const definition of Object.values(MODELS)) {
      if (definition.aliases?.includes(deviceClass)) return { definition, matched: true };
    }
  }
  return { definition: DEFAULT_MODEL, matched: false };
}
