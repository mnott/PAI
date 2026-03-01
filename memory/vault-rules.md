# Vault Connectivity Rules

Rules learned from Obsidian vault maintenance. PAI should apply these proactively
when creating/editing session notes, indexing the vault, or running health checks.

## Wikilink Canonicalization

- Always use the **shortest unambiguous** form: `[[filename]]` not `[[full/path/to/filename]]`
- Obsidian resolves by: exact path match > basename match > closest to source
- Case-insensitive on macOS (HFS+/APFS) — `[[pai]]` matches `PAI.md`
- Never use file extensions in wikilinks: `[[note]]` not `[[note.md]]`
- For aliases in wikilinks: `[[target|display text]]`

## Dual-Symlink Path Handling

The vault uses 18+ symlinks. The same file is reachable through multiple paths.
PAI deduplicates by inode (`device:inode` key).

**Rules:**
- Canonical path = shortest vault-relative path to the file
- When writing wikilinks, always use the canonical path form
- Detect dual-path conflicts: same inode but different wikilink paths in the graph
- Auto-fix: replace alias-path wikilinks with canonical-path wikilinks

## Dead Link Prevention

**When creating session notes:**
- Verify target notes exist before writing `[[wikilinks]]`
- Use `vault_name_index` for resolution (if available)
- Missing targets: create the note or use a different link

**Common dead link causes:**
- Renamed files without updating backlinks
- Deleted files with remaining references
- Typos in wikilink targets
- Path changes from vault reorganization

## Orphan Detection

An orphan is a note with zero inbound wikilinks (nothing links to it).

**Exempt from orphan detection:**
- `_index.md` files (they are entry points, not targets)
- `HOME.md` and `PAI.md` (vault root files)
- Files in `_archive/` directories
- Template files in `templates/`
- README.md and CHANGELOG.md files

**When to create links to prevent orphans:**
- New session notes → add to daily/topic index via frontmatter `links:`
- New topic pages → ensure parent folder note links to them
- Reorganized files → update all backlinks

## Hierarchy Health

Every file should be reachable from the vault root through the link graph.

**Folder notes pattern:**
- Every directory should have an `_index.md` (or `FolderName.md` matching the dir name)
- Folder notes link to all children in that directory
- Parent folder notes link to child folder notes

**Session notes:**
- Must have frontmatter `links:` array pointing to at least one parent context
- Format: `links: ["[[parent-note]]"]`
- Typically link to: daily note, project index, topic page

## Frontmatter Conventions

```yaml
---
links:
- "[[parent-note]]"
- "[[related-topic]]"
tags:
- session
- project-name
---
```

**Rules:**
- `links:` array is the primary connectivity mechanism
- Never modify prose content programmatically — only YAML frontmatter
- Always check idempotency before writing (don't add duplicate links)
- Never modify files in `_archive/` paths

## Graph Health Metrics

**Healthy vault targets:**
- Dead links: 0 (all wikilinks resolve)
- Orphans: <5% of total files
- Health score: >85/100
- Disconnected clusters: 1 (fully connected)

**Warning thresholds:**
- Dead links >10: investigate immediately
- Orphans >10%: batch-connect via folder notes
- Health score <70: structural intervention needed
- Multiple disconnected clusters: bridge with index notes

## Auto-Fix Safety Rules

1. Never delete content
2. Never modify prose (only YAML frontmatter between `---`)
3. Never run edits without explicit user consent (`--apply` flag)
4. Never modify `_archive/` files
5. Always verify changes are idempotent before applying
6. Always report what would change before applying (dry-run by default)
