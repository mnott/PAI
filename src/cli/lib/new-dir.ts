/** `pai new DIR`: resolve the folder, create it when missing, register it as a project. */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CliError } from "../define.js";
import { cmdAdd } from "../impl/project/commands.js";
import { getRegistryBackend } from "../../storage/factory.js";

/** "~", "~/x" -> under the home folder; anything else relative to `cwd`. */
export function resolveDir(raw: string, cwd = process.cwd()): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(cwd, raw);
}

/** A bare word is a session name; ./x ../x /x ~ ~/x or an existing folder is a path. */
export function looksLikePath(arg: string, cwd = process.cwd()): boolean {
  if (/^(\.{1,2}(\/|$)|\/|~(\/|$))/.test(arg)) return true;
  try {
    return statSync(resolve(cwd, arg)).isDirectory();
  } catch {
    return false;
  }
}

export type Register = (dir: string) => Promise<void>;

/** Register through the same code as `pai project add`; an already registered folder is fine. */
export const registerProject: Register = async (dir) => {
  const backend = await getRegistryBackend();
  if (await backend.getProjectByRootPath(dir)) return;
  const code = process.exitCode;
  await cmdAdd(dir, {});
  if (process.exitCode && process.exitCode !== code) {
    process.exitCode = code; // a refused registration (disposable folder) must not fail the launch
  }
};

export async function prepareDir(
  raw: string | undefined,
  o: { dryRun: boolean; out: (s: string) => void; register?: Register }
): Promise<string> {
  const dir = resolveDir(raw ?? ".");
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new CliError(`${dir} exists and is not a folder`, "pai new <another folder>");
  if (o.dryRun) {
    o.out(`(dry run) ${existsSync(dir) ? "would register" : "would create and register"} ${dir}`);
    return dir;
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    o.out(`Created ${dir}`);
  }
  try {
    await (o.register ?? registerProject)(dir);
  } catch (e) {
    o.out(`Could not register ${dir} as a project: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  return dir;
}
