/** Step 20: the dictation transcription model (macOS menu bar app). Writes modelId into dictation.json; never downloads. */

import { DEFAULT_DICTATION_MODEL, DICTATION_MODELS, dictationCurlCommand, installedModelPath, readDictationModelId, writeDictationModelId } from "../dictation-models.js";
import { c, line, section, promptMenu, setupOptions, type Rl } from "../utils.js";

export async function stepDictation(rl: Rl, platform: string = process.platform): Promise<string | null> {
  if (platform !== "darwin") return null;
  section("Step 20: Dictation model (Optional)");
  line();
  line("  The menu bar app transcribes dictation locally with a whisper.cpp model.");
  line();
  const flagged = setupOptions.dictationModel;
  if (flagged !== undefined && !DICTATION_MODELS.some((m) => m.id === flagged)) {
    throw new Error(`--dictation-model must be one of ${DICTATION_MODELS.map((m) => m.id).join(", ")}, got "${flagged}"`);
  }
  const current = readDictationModelId();
  let id = flagged;
  if (id === undefined) {
    const def = current && DICTATION_MODELS.some((m) => m.id === current) ? current : DEFAULT_DICTATION_MODEL;
    if (setupOptions.yes) id = def;
    else {
      const idx = await promptMenu(rl, DICTATION_MODELS.map((m) => ({
        label: `${m.id} (${m.sizeMB} MB) ${installedModelPath(m.id) ? "[installed]" : "[not installed]"}`,
        description: `${m.label}: ${m.note}`,
      })), DICTATION_MODELS.findIndex((m) => m.id === def));
      id = DICTATION_MODELS[idx].id;
    }
  }
  writeDictationModelId(id);
  console.log(c.ok(`Dictation model: ${id}`));
  if (!installedModelPath(id)) {
    line(c.warn(`${id} is not installed. Download it (setup never downloads):`));
    line(`    ${dictationCurlCommand(id)}`);
  }
  return id;
}
