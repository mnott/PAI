/** Catalog and settings helpers for the dictation model chosen in `pai setup` (mirrors PAIMenuBarCore/Dictation.swift). */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { defaultPaiHomeDir } from "../../../config/pai-home.js";

export interface DictationModelInfo { id: string; label: string; sizeMB: number; note: string }

export const DICTATION_MODELS: readonly DictationModelInfo[] = [
  { id: "large-v3-turbo-q5_0", label: "Large v3 turbo (q5_0)", sizeMB: 574, note: "best accuracy/speed balance, default" },
  { id: "medium", label: "Medium", sizeMB: 1530, note: "accurate, slower" },
  { id: "small", label: "Small", sizeMB: 466, note: "fast, decent accuracy" },
  { id: "base", label: "Base", sizeMB: 142, note: "fastest, rough accuracy" },
];
export const DEFAULT_DICTATION_MODEL = "large-v3-turbo-q5_0";

export const dictationModelFile = (id: string): string => `ggml-${id}.bin`;

/** Directories searched for ggml files, in order. */
export function dictationModelDirs(home = homedir()): string[] {
  return [
    join(home, ".pai", "models", "whisper"),
    join(home, ".cache", "aibroker-stt"),
    join(home, "Library", "Application Support", "com.prakashjoshipax.VoiceInk", "WhisperModels"),
  ];
}

/** First existing path of the model's file, null when not installed. */
export function installedModelPath(id: string, home = homedir(), exists: (p: string) => boolean = existsSync): string | null {
  for (const d of dictationModelDirs(home)) {
    const p = join(d, dictationModelFile(id));
    if (exists(p)) return p;
  }
  return null;
}

/** The download command (docs/dictation.md); never run by setup. */
export function dictationCurlCommand(id: string): string {
  const f = dictationModelFile(id);
  return `mkdir -p ~/.pai/models/whisper && curl -L -o ~/.pai/models/whisper/${f} \\\n  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;
}

/** The dictation settings file the menu bar app reads. */
export function dictationSettingsPath(): string {
  return join(process.env.PAI_HOME || defaultPaiHomeDir(), "dictation.json");
}

/** Sets modelId, keeping every other key (unreadable file is replaced). */
export function writeDictationModelId(id: string, path = dictationSettingsPath()): void {
  let cur: Record<string, unknown> = {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) cur = v as Record<string, unknown>;
  } catch { /* missing or unreadable: start fresh */ }
  cur.modelId = id;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readDictationModelId(path = dictationSettingsPath()): string | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as { modelId?: unknown };
    return typeof v.modelId === "string" ? v.modelId : undefined;
  } catch { return undefined; }
}
