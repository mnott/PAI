/** Registered projects as relate inputs (slug + root), active ones whose root exists. */

import { existsSync } from "node:fs";
import { getRegistryBackend } from "../storage/factory.js";
import type { RelateProject } from "./relate.js";

export async function registeredProjects(): Promise<RelateProject[]> {
  const registry = await getRegistryBackend();
  const list = await registry.listProjects({ status: "active", orderBy: "slug" });
  return list.filter((p) => p.root_path && existsSync(p.root_path)).map((p) => ({ id: p.id, slug: p.slug, root: p.root_path }));
}
