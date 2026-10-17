/** `pai cd IDENTIFIER`: print a project's directory (the shell wrapper does the actual cd). */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { getRegistryBackend } from "../../../storage/factory.js";
import { resolveIdentifier } from "../../../cli/commands/project/helpers.js";
import { findMovedPath } from "../../../cli/commands/project/commands.js";
import { err, warn, ok, dim, shortenPath, encodeDir, now } from "../../lib/utils.js";

export async function runCd(identifier: string): Promise<void> {
    const project = await resolveIdentifier(identifier);
    if (!project) {
      console.error(`Project not found: ${identifier}`);
      process.exitCode = 1;
      return;
    }

    if (existsSync(project.root_path)) {
      process.stdout.write(project.root_path + "\n");
      return;
    }

    process.stderr.write(
      warn(`Path not found: ${project.root_path}\n`) +
      dim("  Searching for moved location...\n")
    );

    const result = findMovedPath(project.root_path);

    if (result.found) {
      const newPath = result.found;
      const newEncoded = encodeDir(newPath);
      const ts = now();
      const registry = await getRegistryBackend();
      await registry.updateProjectPath(project.id, { rootPath: newPath, encodedDir: newEncoded }, ts);
      process.stderr.write(
        ok(`Project moved: ${shortenPath(project.root_path, 50)}\n`) +
        dim(`  → ${newPath}\n`) +
        ok("Registry updated.\n")
      );
      process.stdout.write(newPath + "\n");
      return;
    }

    if (result.ambiguous) {
      process.stderr.write(
        warn(`Multiple directories named "${basename(project.root_path)}" found:\n`)
      );
      for (const candidate of result.ambiguous!) {
        process.stderr.write(dim(`  ${candidate}\n`));
      }
      process.stderr.write(
        dim(`\n  Disambiguate with: pai projects rebind ${project.slug} <path>\n`)
      );
      process.exitCode = 1;
      return;
    }

    process.stderr.write(
      err(
        `Project "${project.slug}" root_path "${project.root_path}" does not exist on disk\n` +
        `  and no folder named "${basename(project.root_path)}" was found in scan dirs.\n`
      ) +
      dim(`  Fix with: pai projects rebind ${project.slug} <new-path>\n`)
    );
    process.exitCode = 1;
}
