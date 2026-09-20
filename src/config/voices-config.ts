/**
 * voices-config.ts — voices.json / voices.yaml, the same load-either /
 * migrate pattern as the main config (see main-config.ts) and workers.yaml.
 *
 * Nothing in src/ currently reads voices.json (see the note on
 * migrateVoicesJson in pai-files.ts) — this exists so the one place that
 * would ever load it has the YAML-preferring behaviour already in place,
 * and so `pai config yaml` has one JSON→YAML step to run for it, same as
 * every other PAI config file.
 */

import { paiHomePath } from "./pai-home.js";
import { readDualFormatConfigRaw, migrateMainConfigToYaml, type MainConfigMigrateResult } from "./main-config.js";

export function voicesJsonPath(): string {
  return paiHomePath("voices.json");
}

export function voicesYamlPath(): string {
  return paiHomePath("voices.yaml");
}

/** voices.yaml if it exists, else voices.json, else `{}`. */
export function loadVoicesConfig(): Record<string, unknown> {
  return readDualFormatConfigRaw(voicesJsonPath(), voicesYamlPath());
}

/** `pai config yaml`'s voices.json → voices.yaml step. */
export function migrateVoicesToYaml(opts: { dryRun?: boolean; force?: boolean } = {}): MainConfigMigrateResult {
  return migrateMainConfigToYaml(voicesJsonPath(), { ...opts, yamlPath: voicesYamlPath(), sectionComments: {} });
}
