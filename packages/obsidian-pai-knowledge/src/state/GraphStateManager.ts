/**
 * GraphStateManager — navigation state for the three-level graph drill-down.
 *
 * Level 1: Cluster overview (all bubbles)
 * Level 2: Cluster detail (notes inside a selected cluster)
 * Level 3: Note context (neighbourhood of a selected note)
 *
 * Navigation is stack-based: push to go deeper, pop to go back.
 * Fires "change" events (Obsidian Events mixin) so views can re-render.
 */

import { Events } from "obsidian";
import type { ClusterNode, ClusterNoteRef } from "../client/types";

export type Level = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Navigation context types — one per level
// ---------------------------------------------------------------------------

export interface Level1Context {
  level: 1;
}

export interface Level2Context {
  level: 2;
  cluster: ClusterNode;
}

export interface Level3Context {
  level: 3;
  cluster: ClusterNode;
  note: ClusterNoteRef;
}

export type NavigationContext = Level1Context | Level2Context | Level3Context;

// ---------------------------------------------------------------------------
// Events emitted
// ---------------------------------------------------------------------------

export interface GraphStateEvents {
  /** Fires whenever the navigation stack changes. */
  change: (state: GraphStateSnapshot) => void;
}

export interface GraphStateSnapshot {
  level: Level;
  context: NavigationContext;
  canGoBack: boolean;
  breadcrumbs: string[];
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class GraphStateManager extends Events {
  private stack: NavigationContext[] = [{ level: 1 }];

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  get level(): Level {
    return this.current.level as Level;
  }

  get current(): NavigationContext {
    return this.stack[this.stack.length - 1];
  }

  get canGoBack(): boolean {
    return this.stack.length > 1;
  }

  /**
   * Returns human-readable breadcrumb labels for the current stack.
   * e.g. ["All Clusters", "PAI Infrastructure", "pai-arch-2024.md"]
   */
  get breadcrumbs(): string[] {
    return this.stack.map((ctx) => {
      switch (ctx.level) {
        case 1:
          return "All Clusters";
        case 2:
          return ctx.cluster.label;
        case 3:
          return ctx.note.title || ctx.note.vault_path.split("/").pop() || "Note";
      }
    });
  }

  snapshot(): GraphStateSnapshot {
    return {
      level: this.level,
      context: this.current,
      canGoBack: this.canGoBack,
      breadcrumbs: this.breadcrumbs,
    };
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * Navigate into a cluster (Level 1 → Level 2).
   */
  pushCluster(cluster: ClusterNode): void {
    this.stack.push({ level: 2, cluster });
    this.trigger("change", this.snapshot());
  }

  /**
   * Navigate into a note's neighbourhood (Level 2 → Level 3).
   */
  pushNote(cluster: ClusterNode, note: ClusterNoteRef): void {
    this.stack.push({ level: 3, cluster, note });
    this.trigger("change", this.snapshot());
  }

  /**
   * Go back one level in the navigation stack.
   * No-op if already at Level 1.
   */
  pop(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.trigger("change", this.snapshot());
    }
  }

  /**
   * Jump back to Level 1 (the cluster overview), clearing the entire stack.
   */
  reset(): void {
    this.stack = [{ level: 1 }];
    this.trigger("change", this.snapshot());
  }

  /**
   * Navigate to a specific breadcrumb index (0-based).
   */
  navigateTo(index: number): void {
    if (index < 0 || index >= this.stack.length) return;
    this.stack = this.stack.slice(0, index + 1);
    this.trigger("change", this.snapshot());
  }
}
