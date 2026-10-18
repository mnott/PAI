// Decides whether a new repo-root file name looks like local-model scratch.
const SCRATCH_NAME = /^(tmp|temp|scratch|debug|probe|check|try|test_|out|output)[\w.-]*$/i;
const SCRATCH_EXT = /\.(log|out|tmp)$/i;
const SCRIPT_EXT = /\.(py|mjs|cjs|js|rb|sh)$/i;
const RUNNER_NAME = /^(test|run)/i;

const extOf = (n: string): string => (n.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase();

/** repoExts: lowercase extensions (".py") of files already in the repo. */
export function isScratchRootFile(name: string, repoExts: ReadonlySet<string>): boolean {
  if (SCRATCH_NAME.test(name) || SCRATCH_EXT.test(name)) return true;
  if (!SCRIPT_EXT.test(name)) return false;
  const ext = extOf(name);
  if (!repoExts.has(ext)) return true;
  return /\.(mjs|cjs|js)$/i.test(name) && RUNNER_NAME.test(name);
}
