/** Projects, tasks, config and infrastructure commands, by the group of `pai more` they are listed under. */

import type { CommandDef, GroupId } from "../define.js";
import { configCommand } from "./config.js";
import { daemonCommand } from "./daemon.js";
import { dbCommand } from "./db.js";
import { identityCommand } from "./identity.js";
import { issueCommand } from "./issue.js";
import { planCommand } from "./plan.js";
import { mcpCommand } from "./mcp.js";
import { notifyCommand } from "./notify.js";
import { projectAliasCommand, projectCommand } from "./project.js";
import { registryCommand } from "./projects-registry.js";
import { taskAliasCommand, taskCommand } from "./task.js";
import { topicCommand } from "./topic.js";

export const BATCH_C: Partial<Record<GroupId, CommandDef[]>> = {
  workers: [planCommand],
  memory: [projectCommand, projectAliasCommand, registryCommand, taskCommand, taskAliasCommand, issueCommand, identityCommand, topicCommand],
  daemon: [daemonCommand, configCommand, mcpCommand, notifyCommand, dbCommand],
};
