/**
 * Type surface of snapshot.js (the extension itself is plain ESM with no
 * build step; this file exists so the vitest/TS side can import it strictly).
 */

export interface SnapshotNode {
  nodeId: number;
  nodeName: string;
  nodeType: number;
  attrs?: Record<string, string>;
  children?: SnapshotNode[];
}

export declare function buildSnapshot(domNodeTree: SnapshotNode): {
  yaml: string;
  refMap: Record<string, number>;
};
