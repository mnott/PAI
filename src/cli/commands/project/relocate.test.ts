import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { norm, relocateRenamedAncestor, suggestMovedPath } from "./relocate.js";

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

describe("an ordering prefix was added or removed", () => {
  /**
   * The vault numbers directories to force sort order — `04 - Ablage`,
   * `08 - Others`, `20 - Webseiten` — and gaining or losing that prefix is the
   * same kind of rename as gaining an emoji. norm() cannot see it because the
   * digits survive: "webseiten" against "20webseiten".
   *
   * Found because MDF.md links to `Infrastruktur/20 - Webseiten` while the
   * registry holds a dead entry for plain `Infrastruktur/Webseiten`.
   */
  it("matches a directory that gained a numeric prefix", () => {
    mkdirSync(join(root, "Infrastruktur", "20 - Webseiten"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Infrastruktur", "Webseiten"))).toBe(
      join(root, "Infrastruktur", "20 - Webseiten")
    );
  });

  it("matches a directory that lost its numeric prefix", () => {
    mkdirSync(join(root, "Infrastruktur", "Webseiten"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Infrastruktur", "20 - Webseiten"))).toBe(
      join(root, "Infrastruktur", "Webseiten")
    );
  });

  it("accepts the separators actually used", () => {
    for (const [i, dir] of ["01. Alpha", "02_Alpha", "03) Alpha", "04Alpha"].entries()) {
      const parent = join(root, `p${i}`);
      mkdirSync(join(parent, dir), { recursive: true });
      expect(relocateRenamedAncestor(join(parent, "Alpha")), dir).toBe(join(parent, dir));
    }
  });

  it("does NOT treat a shared suffix as a match", () => {
    // The loose version of this rule — "one normalised name ends with the other"
    // — would match a wanted `Setup` to `01 - Base Setup`, a different directory.
    // Only a leading run of digits comes off.
    mkdirSync(join(root, "Infra", "01 - Base Setup"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Infra", "Setup"))).toBeUndefined();
  });

  it("still refuses when the prefix rule creates ambiguity", () => {
    mkdirSync(join(root, "Parent", "Alpha"), { recursive: true });
    mkdirSync(join(root, "Parent", "20 - Alpha"), { recursive: true });
    expect(relocateRenamedAncestor(join(root, "Parent", "Alpha", "x"))).toBeUndefined();
  });
});

describe("never relocating onto another project's directory", () => {
  /**
   * Caught by the AIBroker session: `~/PAI` was "recovered" to `~/dev/ai/PAI`,
   * which resolves to `~/Daten/Cloud/Development/ai/PAI` — a directory an ACTIVE
   * project already owns. Two registry entries for one directory is the mess that
   * had been merged out of this registry hours earlier.
   *
   * String comparison is what missed it: the two paths share nothing after
   * `/Users/i052341/`. It has to be realpath.
   */
  it("refuses a candidate another project owns under a different spelling", () => {
    const realDir = join(root, "cloud", "PAI");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(root, "dev"), { recursive: true });
    symlinkSync(realDir, join(root, "dev", "PAI"));

    const registered = join(root, "gone", "PAI");

    // On its own the basename-style walk would offer the symlinked spelling.
    expect(suggestMovedPath(registered, [])).toBeUndefined(); // nothing above survives here

    // The case that matters: a resolvable candidate, already owned.
    const owned = join(root, "cloud", "🧠 Vault");
    mkdirSync(owned, { recursive: true });
    mkdirSync(join(root, "link"), { recursive: true });
    symlinkSync(owned, join(root, "link", "Vault"));

    expect(suggestMovedPath(join(root, "cloud", "Vault"), [])).toBe(owned);
    expect(suggestMovedPath(join(root, "cloud", "Vault"), [join(root, "link", "Vault")]))
      .toBeUndefined();
  });

  it("allows a candidate no other project owns", () => {
    mkdirSync(join(root, "cloud", "🧠 Vault"), { recursive: true });
    expect(
      suggestMovedPath(join(root, "cloud", "Vault"), [join(root, "somewhere", "else")])
    ).toBe(join(root, "cloud", "🧠 Vault"));
  });

  it("does not treat two unresolvable paths as the same directory", () => {
    // realOrSelf falls back to the literal path; two different missing paths must
    // not collide into one another and veto a good relocation.
    mkdirSync(join(root, "cloud", "🧠 Vault"), { recursive: true });
    expect(
      suggestMovedPath(join(root, "cloud", "Vault"), [
        join(root, "missing-a"),
        join(root, "missing-b"),
      ])
    ).toBe(join(root, "cloud", "🧠 Vault"));
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
