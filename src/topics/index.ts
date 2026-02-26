/**
 * src/topics — Topic shift detection for PAI sessions.
 *
 * Public API for detecting when a Claude session has drifted to a different
 * project/topic than what was originally routed.
 */

export { detectTopicShift } from "./detector.js";
export type { TopicCheckParams, TopicCheckResult } from "./detector.js";
