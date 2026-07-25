/**
 * Matterbridge plugin for Ecovacs robot vacuums (Deebot, yeedi).
 * Exposes each robot on the Ecovacs account as a Matter RVC (Robotic Vacuum
 * Cleaner) device, compatible with Apple HomeKit, Alexa, Google Home and
 * SmartThings via Matterbridge.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import { EcovacsPlatform } from './platform.js';

/**
 * Standard Matterbridge plugin initializer.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {PlatformConfig} config - The platform configuration.
 * @returns {EcovacsPlatform} A new EcovacsPlatform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): EcovacsPlatform {
  return new EcovacsPlatform(matterbridge, log, config);
}

export { DEFAULT_MODEL, MODELS, resolveModel } from './models/models.js';
export type { CleanModeKey, CleanSpeedDefinition, CleanSpeedTag, ModelDefinition, SpotAreaStrategy } from './models/types.js';
export type { EcovacsPlatformConfig } from './platform.js';
export { EcovacsPlatform } from './platform.js';
export { VacuumDevice } from './vacuum_device.js';
