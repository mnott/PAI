/**
 * relocate.ts — find a registered project whose ancestor directory was renamed.
 *
 * The registry stores absolute root paths. Rename any directory ABOVE a project
 * and every project underneath it goes missing at once — `existsSync` fails, and
 * the health check reported them as dead and offered to archive them. Renaming
 * `Ideaverse` to `🧠 Ideaverse` orphaned a whole subtree that way: 32 entries, all
 * still on disk, none of them findable.
 *
 * The old suggestion logic could not see this. It took the project's BASENAME and
 * looked for it in four hardcoded directories (`~/dev`, `~/dev/ai`, `~/Desktop`,
 * `~/Projects`), so it could only recognise "the leaf moved into a place I already
 * know about". A renamed ancestor leaves the leaf exactly where it was.
 *
 * So walk down from the root while the path still exists — that lands on the
 * deepest surviving ancestor, which is precisely where the rename happened — then
 * match the remaining segments by NORMALISED name. Normalising strips the emoji,
 * the space and the case, so `🧠 Ideaverse` and `Ideaverse` both reduce to
 * "ideaverse". The general case is "an ancestor was renamed decoratively", which
 * is the whole class of failure rather than this one instance of it.
 *
 * Algorithm and the measurements behind it come from the AIBroker session, which
 * probed it and handed it over rather than implementing it in a file that was not
 * theirs.
 */

import { existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { homedir } from "node:os";

/**
 * A directory name reduced to what a rename is unlikely to have changed.
 *
 * NFC first because macOS hands back decomposed Unicode: an "ä" typed in one
 * place and read from a directory listing in another are different byte
 * sequences, and comparing them raw fails for reasons no one can see. Then case
 * and every non-alphanumeric are dropped, which is what makes `🧠 Ideaverse`
 * match `Ideaverse` — and, unavoidably, what makes `my-project` match
 * `my project`. That looseness is the point, and the uniqueness rule below is
 * what keeps it safe.
 */
export function norm(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** Hidden by Unix convention — tool state rather than a project directory. */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Drop a leading ordering prefix: `20 - Webseiten` -> `Webseiten`.
 *
 * This vault numbers directories to force sort order — `04 - Ablage`,
 * `08 - Others`, `01 - Base Setup`, `20 - Webseiten` — and adding or removing that
 * prefix is a rename of exactly the same kind as adding an emoji. `norm()` alone
 * cannot see it, because the digits survive normalisation: "webseiten" against
 * "20webseiten".
 *
 * Found because `MDF.md` links to `Infrastruktur/20 - Webseiten` while the
 * registry has a dead entry for plain `Infrastruktur/Webseiten`. The note files
 * knew where it went.
 *
 * Deliberately NOT a general suffix match, and the reason is worth spelling out
 * because "why not just match on the suffix" is the obvious next question.
 *
 * `MDF/Infrastruktur/` is wall-to-wall numbered: `00 - Migration Analysis`,
 * `01 - Base Setup`, `02 - Storage Setup`, `03 - Network Setup`, and so on. A
 * suffix rule on a wanted `Setup` hits eight of them at once — so the uniqueness
 * rule below would veto it, and the danger would never show itself. The one that
 * bites is a wanted `Analysis` against `00 - Migration Analysis`: a single hit,
 * therefore silently relocated, therefore wrong, and uniqueness cannot save you
 * because there is nothing ambiguous about it.
 *
 * That is a failure mode this file's own safety rule would have HIDDEN rather than
 * caught. Only a leading run of digits with optional separator comes off.
 */
function stripOrderingPrefix(name: string): string {
  return name.replace(/^\d+\s*[-._)]?\s*/, "");
}

/**
 * The names under which a directory can be recognised.
 *
 * Both spellings are offered from both sides, so the prefix can have been added
 * OR removed since the path was registered.
 */
function matchKeys(name: string): Set<string> {
  const keys = new Set<string>();
  const bare = norm(name);
  if (bare) keys.add(bare);
  const stripped = norm(stripOrderingPrefix(name));
  if (stripped) keys.add(stripped);
  return keys;
}

function shareAKey(a: Set<string>, b: Set<string>): boolean {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

/**
 * Resolve symlinks so two spellings of one directory compare equal.
 *
 * Falls back to the input when it cannot resolve — a path that does not exist has
 * no real path, and for the duplicate check below "unresolvable" must not
 * accidentally equal some other unresolvable path.
 */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a project went when a directory above it was renamed.
 *
 * Returns undefined rather than a guess whenever it cannot be certain — see the
 * uniqueness rule inside. undefined means "still dead as far as this can tell",
 * which leaves the entry exactly as it was.
 */
export function relocateRenamedAncestor(rootPath: string): string | undefined {
  // Nothing to relocate. Worth an explicit early return: a caller that asks
  // about a live path must not be told it "moved" to itself.
  if (existsSync(rootPath)) return undefined;

  const segments = rootPath.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  // Walk DOWN while the path still exists. What survives is the deepest existing
  // ancestor, and the first segment that does not is the renamed one.
  const absolute = rootPath.startsWith(sep);
  let current = absolute ? sep : "";
  let i = 0;
  for (; i < segments.length; i++) {
    const next = join(current, segments[i]!);
    if (!existsSync(next)) break;
    current = next;
  }

  // Every segment resolved, yet the whole path does not exist. Should be
  // unreachable, and returning undefined is the safe reading of a contradiction.
  if (i === segments.length) return undefined;

  for (; i < segments.length; i++) {
    const wanted = matchKeys(segments[i]!);
    if (wanted.size === 0) return undefined; // punctuation only — nothing to match on

    let children: string[];
    try {
      children = readdirSync(current);
    } catch {
      return undefined; // unreadable directory — cannot claim to know
    }

    const hits = children.filter(
      (c) =>
        isDir(join(current, c)) &&
        shareAKey(matchKeys(c), wanted) &&
        // A leading dot is not decoration, so it must not normalise away.
        //
        // Caught on the first real run: `~/PAI` was "relocated" to `~/.pai`,
        // because norm() strips the dot and both reduce to "pai". `~/.pai` is
        // PAI's own registry and state directory — not a project — and the
        // uniqueness rule below could not save us, since there was exactly one
        // match. A hidden sibling is a category difference (`.git`, `.claude`,
        // `.pai` are tool state), not a rename of the visible one.
        isHidden(c) === isHidden(segments[i]!)
    );

    // THE SAFETY PROPERTY. Two directories that normalise the same means this
    // cannot tell which one the project was, and repointing a registered slug at
    // the wrong project would silently attach it to someone else's notes — worse
    // than leaving the entry dead, because it looks fixed. Ambiguity is not a
    // relocation.
    if (hits.length !== 1) return undefined;

    current = join(current, hits[0]!);
  }

  return current;
}

/**
 * The pre-existing guess: the project's leaf name in one of a few usual places.
 *
 * Kept, and kept SECOND, because it answers a different question — "the project
 * itself was moved somewhere I know about" rather than "an ancestor was renamed".
 * It is the weaker of the two: matching on basename alone can point at an
 * unrelated directory that happens to share a name, so it only gets to answer
 * when the ancestor walk has declined.
 */
function suggestByBasename(rootPath: string): string | undefined {
  const name = basename(rootPath);
  const candidates = [
    join(homedir(), "dev", name),
    join(homedir(), "dev", "ai", name),
    join(homedir(), "Desktop", name),
    join(homedir(), "Projects", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Where a missing project probably is, or undefined.
 *
 * Feeds the health check's `suggestedPath ? "stale" : "dead"` classification, so
 * an answer here moves an entry out of the dead list and into the one `--fix`
 * repairs.
 *
 * `otherRoots` is every OTHER registered project's root path, and it is what
 * stops a repair from becoming a duplicate. Caught by the AIBroker session on the
 * first version of this: `~/PAI` was "recovered" to `~/dev/ai/PAI`, which is a
 * second spelling of `~/Daten/Cloud/Development/ai/PAI` — a path an ACTIVE project
 * already owns. Two registry entries for one directory is the exact mess that was
 * merged out of this registry earlier the same day.
 *
 * The comparison must be by realpath, not string. String equality is precisely
 * what missed it: the two paths share not one character after `/Users/owner/`.
 */
export function suggestMovedPath(
  rootPath: string,
  otherRoots: readonly string[] = []
): string | undefined {
  const candidate = relocateRenamedAncestor(rootPath) ?? suggestByBasename(rootPath);
  if (!candidate) return undefined;

  const taken = new Set(otherRoots.map(realOrSelf));
  if (taken.has(realOrSelf(candidate))) return undefined;

  return candidate;
}
