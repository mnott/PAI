import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { norm, relocateRenamedAncestor } from "./relocate.js";

/**
 * Recovering projects orphaned by a renamed ancestor.
 *
 * Renaming `Ideaverse` to `🧠 Ideaverse` made 32 registered projects vanish at
 * once — every one still on disk, none findable, all offered up for archiving as
 * dead. The leaf directories never moved; something above them did, which is
 * exactly what basename matching cannot see.
 *
 * The uniqueness rule is the property worth defending hardest. A wrong answer
 * here repoints a registered slug at a different project's notes and *looks
 * fixed*, which is worse than an entry that stays dead and obvious.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-relocate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("normalising a directory name", () => {
  it("reduces a decorated name to its bare form", () => {
    expect(norm("🧠 Ideaverse")).toBe("ideaverse");
    expect(norm("Ideaverse")).toBe("ideaverse");
  });

  it("ignores case, spaces and punctuation", () => {
    expect(norm("04 - Ablage")).toBe("04ablage");
    expect(norm("04-Ablage")).toBe("04ablage");
  });

  it("treats decomposed and precomposed Unicode as the same name", () => {
    // macOS readdir hands back decomposed forms. Without NFC these differ byte
    // for byte and the match fails for a reason nobody can see by reading it.
    expect(norm("Stadtoldendorf-Ü")).toBe(norm("Stadtoldendorf-Ü"));
  });
});

describe("an ancestor was renamed", () => {
  it("finds a project under a directory that gained an emoji", () => {
    // The measured case, in miniature.
    mkdirSync(join(root, "🧠 Ideaverse", "Appstore", "ringsaday"), { recursive: true });

    const registered = join(root, "Ideaverse", "Appstore", "ringsaday");
    expect(relocateRenamedAncestor(registered)).toBe(
      join(root, "🧠 Ideaverse", "Appstore", "ringsaday")
    );
  });

  it("recovers a whole subtree from one rename, entry by entry", () => {
    // 32 entries went dead from a single rename. Each is resolved independently,
    // so a partial disk state cannot take the rest down with it.
    mkdirSync(join(root, "🧠 Ideaverse", "Appstore", "ringsaday"), { recursive: true });
    mkdirSync(join(root, "🧠 Ideaverse", "Raspi", "Stadtoldendorf"), { recursive: true });

    expect(relocateRenamedAncestor(join(root, "Ideaverse", "Appstore", "ringsaday"))).toBe(
      join(root, "🧠 Ideaverse", "Appstore", "ringsaday")
    );
    expect(relocateRenamedAncestor(join(root, "Ideaverse", "Raspi", "Stadtoldendorf"))).toBe(
      join(root, "🧠 Ideaverse", "Raspi", "Stadtoldendorf")
    );
  });

  it("handles a rename several levels up", () => {
    mkdirSync(join(root, "Cloud", "🧠 Vault", "a", "b", "c"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Cloud", "Vault", "a", "b", "c"))).toBe(
      join(root, "Cloud", "🧠 Vault", "a", "b", "c")
    );
  });

  it("resolves more than one renamed segment on the same path", () => {
    mkdirSync(join(root, "🧠 Ideaverse", "📱 Appstore", "ringsaday"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Ideaverse", "Appstore", "ringsaday"))).toBe(
      join(root, "🧠 Ideaverse", "📱 Appstore", "ringsaday")
    );
  });
});

describe("refusing to guess", () => {
  it("returns undefined when the leaf is genuinely gone", () => {
    // The SAP/* entries measured on the real registry: the ancestor rename is
    // real, but `SAP` no longer exists underneath it. Those are dead, and
    // archiving them is the correct outcome — a partial result is the algorithm
    // working, not failing.
    mkdirSync(join(root, "🧠 Ideaverse", "Appstore"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Ideaverse", "SAP", "DPO"))).toBeUndefined();
  });

  it("returns undefined when two siblings normalise identically", () => {
    // THE safety property. Repointing a slug at the wrong project attaches it to
    // someone else's notes and looks fixed.
    mkdirSync(join(root, "🧠 Ideaverse"), { recursive: true });
    mkdirSync(join(root, "Ideaverse!"), { recursive: true });

    expect(relocateRenamedAncestor(join(root, "Ideaverse", "thing"))).toBeUndefined();
  });

  it("returns undefined for a path that exists — a live project has not moved", () => {
    const live = join(root, "real");
    mkdirSync(live, { recursive: true });
    expect(relocateRenamedAncestor(live)).toBeUndefined();
  });

  it("does not match a FILE whose name fits", () => {
    // A project root is a directory. Matching a file would produce a path that
    // exists and is nonetheless wrong.
    mkdirSync(join(root, "Parent"), { recursive: true });
    writeFileSync(join(root, "Parent", "target"), "not a directory");
    expect(relocateRenamedAncestor(join(root, "Parent", "Target", "sub"))).toBeUndefined();
  });

  it("never relocates a visible directory into a hidden one", () => {
    // Found on the FIRST real run against the registry, not in review: `~/PAI`
    // was "recovered" as `~/.pai` — PAI's own state and registry directory, not a
    // project. norm() strips the leading dot, so both reduce to "pai", and the
    // uniqueness rule could not help because there was exactly one match. A
    // hidden sibling is a different kind of thing, not a renamed version of the
    // visible one.
    mkdirSync(join(root, ".pai"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "PAI"))).toBeUndefined();
  });

  it("still relocates a hidden directory that was itself renamed", () => {
    // The rule is symmetry, not "ignore hidden things".
    mkdirSync(join(root, ".🧠 config"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, ".config"))).toBe(join(root, ".🧠 config"));
  });

  it("does not match a dangling symlink", () => {
    // Measured: `🧠 Ideaverse/Raspi/Stadtoldendorf` is a symlink to
    // `08 - Others/MDF/Stadtoldendorf`, which no longer exists. The name matches
    // perfectly and the entry still cannot be recovered — relocating onto a
    // broken link produces a path existsSync rejects, so health would re-flag it
    // dead on the next run and the "fix" would be pure churn.
    //
    // isDir() uses statSync, which follows the link and throws, so this is
    // already handled — the test exists because it is not obvious from reading
    // the code, and because AIBroker's probe predicted this entry WOULD recover.
    mkdirSync(join(root, "Parent"), { recursive: true });
    symlinkSync(join(root, "does-not-exist"), join(root, "Parent", "target"));

    expect(relocateRenamedAncestor(join(root, "Parent", "Target"))).toBeUndefined();
  });

  it("does match a symlink that points at a real directory", () => {
    // The rule is "must resolve to a directory", not "must not be a symlink".
    // PAI's own note directories are symlinked into the Obsidian vault.
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(root, "Parent"), { recursive: true });
    symlinkSync(real, join(root, "Parent", "🧠 target"));

    expect(relocateRenamedAncestor(join(root, "Parent", "target"))).toBe(
      join(root, "Parent", "🧠 target")
    );
  });

  it("returns undefined when nothing above the project survives", () => {
    expect(
      relocateRenamedAncestor(join(root, "gone", "also-gone", "project"))
    ).toBeUndefined();
  });

  it("does not fall for a segment that normalises to nothing", () => {
    // "---" reduces to "" and would otherwise match every sibling equally.
    mkdirSync(join(root, "Parent", "a"), { recursive: true });
    mkdirSync(join(root, "Parent", "b"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Parent", "---"))).toBeUndefined();
  });
});
