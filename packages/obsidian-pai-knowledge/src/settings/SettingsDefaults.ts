/**
 * Default values for all PAI Knowledge Graph plugin settings.
 * Import this object wherever settings need to be initialised.
 */

export interface PaiPluginSettings {
  /** Absolute path to the PAI daemon Unix socket */
  socketPath: string;
  /**
   * Minimum cluster size (number of notes) for a cluster to be shown.
   * Range: 2–10
   */
  minClusterSize: number;
  /**
   * Maximum number of clusters to render at once.
   * Range: 5–50
   */
  maxClusters: number;
  /**
   * Only include notes indexed within this many days.
   * Range: 7–365
   */
  lookbackDays: number;
  /**
   * Cosine similarity threshold used for grouping (0.0–1.0).
   * Lower = more/larger clusters, higher = fewer/tighter clusters.
   */
  similarityThreshold: number;
}

export const DEFAULT_SETTINGS: PaiPluginSettings = {
  socketPath: "/tmp/pai.sock",
  minClusterSize: 3,
  maxClusters: 20,
  lookbackDays: 90,
  similarityThreshold: 0.6,
};
