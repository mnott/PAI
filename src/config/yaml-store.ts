/**
 * yaml-store.ts — generic, comment-preserving YAML file helpers shared by
 * every PAI config file that has a YAML form (config.yaml, voices.yaml;
 * workers.yaml keeps its own writer in workers-config.ts because it needs
 * provider-specific key-quoting, but its atomic-write tail is this module's
 * writeYamlFileAtomic).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { Document, YAMLMap, parseDocument, type Node, type Pair, type Scalar } from "yaml";

export class YamlStoreError extends Error {}

/**
 * Validate `text` parses as YAML, back up any existing file to `.bak-pai`,
 * then write via temp file + rename (atomic within a filesystem) at mode
 * 0600 — every PAI-owned YAML file can carry secrets, key or no key.
 */
export function writeYamlFileAtomic(path: string, text: string, opts: { label?: string } = {}): void {
  const label = opts.label ?? path;
  const parsed = parseDocument(text);
  if (parsed.errors.length) {
    throw new YamlStoreError(`refusing to write ${label}: ${parsed.errors[0].message} (previous file left unchanged)`);
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak-pai`);
    } catch (e) {
      throw new YamlStoreError(
        `Could not back up ${label}: ${e instanceof Error ? e.message : String(e)}\nRefusing to write without a backup.`
      );
    }
  }
  const tmp = `${path}.tmp-pai-${process.pid}`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new YamlStoreError(`Failed to write ${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Deep-equal for plain JSON-shaped values (objects/arrays/scalars). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply the diff between `before` and `after` (arbitrary nested plain JSON
 * objects) onto a YAML Document, touching only the leaves/keys that actually
 * changed — this is what lets hand-written comments elsewhere in the file
 * survive a `set`/`unset`. Arrays and non-object values are replaced
 * wholesale when they differ; only plain objects are diffed key by key.
 */
export function syncPlainObjectIntoYamlDoc(
  doc: Document,
  before: unknown,
  after: unknown,
  path: (string | number)[] = []
): void {
  if (isPlainObject(after) && isPlainObject(before)) {
    for (const key of Object.keys(after)) {
      syncPlainObjectIntoYamlDoc(doc, before[key], after[key], [...path, key]);
    }
    for (const key of Object.keys(before)) {
      if (!(key in after)) doc.deleteIn([...path, key]);
    }
    return;
  }
  if (after === undefined) {
    if (before !== undefined) doc.deleteIn(path);
    return;
  }
  if (!deepEqualJson(before, after)) {
    doc.setIn(path, after);
  }
}

/**
 * Attach a `# text` comment directly above the key at `path` inside a YAML
 * Document — used for the annotated section headers `pai config yaml`
 * writes. No-op if the path does not resolve to a mapping entry (e.g. the
 * key was omitted from the document).
 */
export function setYamlKeyComment(doc: Document, path: (string | number)[], text: string): void {
  const parentPath = path.slice(0, -1);
  const lastKey = path[path.length - 1];
  const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
  if (!(parent instanceof YAMLMap)) return;
  const pair = (parent.items as Pair[]).find((p) => (p.key as Scalar)?.value === lastKey);
  if (pair) {
    (pair.key as Node & { commentBefore?: string }).commentBefore = ` ${text}`;
  }
}
