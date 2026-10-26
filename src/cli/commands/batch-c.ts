/** Projects, tasks, config and infrastructure commands, by the group of `pai more` they are listed under. */

import { paneCommand } from "./pane.js";
import type { CommandDef, GroupId } from "../define.js";
import { buildCommand } from "./build.js";
import { configCommand } from "./config.js";
import { daemonCommand } from "./daemon.js";
import { dbCommand } from "./db.js";
import { homeCommand } from "./home.js";
import { identityCommand } from "./identity.js";
import { issueCommand } from "./issue.js";
import { planCommand } from "./plan.js";
import { queueCommand } from "./queue.js";
import { mcpCommand } from "./mcp.js";
import { notifyCommand } from "./notify.js";
import { projectAliasCommand, projectCommand } from "./project.js";
import { registryCommand } from "./projects-registry.js";
import { taskAliasCommand, taskCommand } from "./task.js";
import { topicCommand } from "./topic.js";
import { uhpCommand } from "./uhp.js";

export const BATCH_C: Partial<Record<GroupId, CommandDef[]>> = {
  workers: [planCommand, queueCommand, uhpCommand, buildCommand, paneCommand],
  memory: [projectCommand, projectAliasCommand, registryCommand, taskCommand, taskAliasCommand, issueCommand, identityCommand, topicCommand],
  daemon: [daemonCommand, configCommand, homeCommand, mcpCommand, notifyCommand, dbCommand],
};
