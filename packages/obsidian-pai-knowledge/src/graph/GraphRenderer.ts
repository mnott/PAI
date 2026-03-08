/**
 * GraphRenderer — thin Cytoscape.js wrapper for the PAI Knowledge Graph.
 *
 * Responsibilities:
 * - Initialise the Cytoscape instance inside the provided container element.
 * - Render Level 1: semantic cluster bubbles from ClusterNode[]
 * - Emit events for interactions (node click, background click) via a simple
 *   callback interface so views stay decoupled from the renderer.
 *
 * Layout notes:
 * - Uses the built-in 'cose' (Compound Spring Embedder) layout.
 *   If cytoscape-fcose is bundled in future, switch to 'fcose' for better quality.
 * - Node sizes are proportional to sqrt(cluster.size) to avoid huge bubbles
 *   overwhelming small ones — square-root scaling is perceptually balanced.
 */

import cytoscape, {
  Core,
  ElementsDefinition,
  NodeSingular,
} from "cytoscape";
import type { ClusterNode, NoteNode, GraphNeighborhoodResult } from "../client/types";
import { clusterStylesheet, noteStylesheet, colorForType } from "./GraphStyles";

// ---------------------------------------------------------------------------
// Public event callbacks
// ---------------------------------------------------------------------------

export interface GraphRendererCallbacks {
  /** Fired when the user single-clicks a cluster node */
  onClusterClick?: (cluster: ClusterNode) => void;
  /** Fired when the user single-clicks a note node (Level 2) */
  onNoteClick?: (note: NoteNode) => void;
  /** Fired when the user taps the background (deselect) */
  onBackgroundClick?: () => void;
}

// ---------------------------------------------------------------------------
// Sizing constants
// ---------------------------------------------------------------------------

const NODE_BASE_SIZE = 60; // px — minimum node dimension
const NODE_SCALE = 14; // px added per sqrt(note) beyond 1
const FONT_SIZE_BASE = 11; // px
const FONT_SIZE_SCALE = 2; // px per sqrt(note)

// ---------------------------------------------------------------------------
// GraphRenderer
// ---------------------------------------------------------------------------

export class GraphRenderer {
  private cy: Core | null = null;
  private container: HTMLElement;
  private callbacks: GraphRendererCallbacks;
  /** Map from cytoscape node id → original ClusterNode for click events */
  private clusterById = new Map<string, ClusterNode>();
  /** Map from cytoscape node id → original NoteNode for Level 2 click events */
  private noteById = new Map<string, NoteNode>();

  constructor(container: HTMLElement, callbacks: GraphRendererCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /**
   * Create and mount the Cytoscape instance.
   * Must be called once before any render method.
   */
  init(): void {
    if (this.cy) return;

    this.cy = cytoscape({
      container: this.container,
      elements: [],
      style: clusterStylesheet(),
      layout: { name: "preset" },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      autoungrabify: false,
      minZoom: 0.1,
      maxZoom: 5,
    });

    // Background click → deselect
    this.cy.on("tap", (evt) => {
      if (evt.target === this.cy) {
        this.callbacks.onBackgroundClick?.();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Level 1: Cluster overview
  // ---------------------------------------------------------------------------

  /**
   * Render a flat collection of cluster nodes using a force-directed layout.
   * Replaces any existing graph content.
   *
   * @param clusters  Array of ClusterNode objects from the daemon
   */
  renderClusters(clusters: ClusterNode[]): void {
    if (!this.cy) {
      throw new Error("GraphRenderer.init() must be called before renderClusters()");
    }

    this.clusterById.clear();
    this.noteById.clear();

    // Reset to cluster-level stylesheet when returning from Level 2
    this.cy.style(clusterStylesheet());

    const elements: ElementsDefinition = {
      nodes: clusters.map((cluster) => {
        const nodeId = `cluster-${cluster.id}`;
        this.clusterById.set(nodeId, cluster);

        const sqrtSize = Math.sqrt(cluster.size);
        const dim = NODE_BASE_SIZE + sqrtSize * NODE_SCALE;
        const fontSize = FONT_SIZE_BASE + sqrtSize * FONT_SIZE_SCALE;

        // Truncate long labels: "PAI Knowledge Infrastructure" → "PAI Knowledge\nInfrastructure"
        const labelLines = this.wrapLabel(cluster.label, 18);

        return {
          data: {
            id: nodeId,
            label: labelLines,
            color: colorForType(cluster.dominant_observation_type),
            width: dim,
            height: dim,
            fontSize: `${Math.round(fontSize)}px`,
            textMaxWidth: `${Math.round(dim * 0.85)}px`,
            // String booleans for Cytoscape selector matching
            suggestIndex: cluster.suggest_index_note ? "true" : "false",
            hasIdea: cluster.has_idea_note ? "true" : "false",
            // Stash raw cluster data for tooltip use
            _cluster: cluster,
          },
        };
      }),
      edges: [],
    };

    this.cy.elements().remove();
    this.cy.add(elements);

    // Bind click handlers on new nodes
    this.cy.nodes().on("tap", (evt) => {
      const node = evt.target as NodeSingular;
      const cluster = this.clusterById.get(node.id());
      if (cluster) {
        this.callbacks.onClusterClick?.(cluster);
      }
    });

    // Run force-directed layout
    this.cy
      .layout({
        name: "cose",
        animate: true,
        animationDuration: 600,
        animationEasing: "ease-out",
        nodeRepulsion: () => 8000,
        nodeOverlap: 20,
        idealEdgeLength: () => 120,
        gravity: 0.25,
        numIter: 1000,
        randomize: false,
        componentSpacing: 80,
      })
      .run();

    // Fit after layout finishes
    this.cy.one("layoutstop", () => {
      this.cy?.fit(undefined, 40);
    });
  }

  // ---------------------------------------------------------------------------
  // Level 2: Note detail view
  // ---------------------------------------------------------------------------

  /**
   * Render individual notes inside a cluster and the wikilink / semantic edges
   * between them. Replaces any existing graph content and switches to the
   * note-level stylesheet.
   *
   * @param result  GraphNeighborhoodResult from the daemon
   */
  renderNotes(result: GraphNeighborhoodResult): void {
    if (!this.cy) {
      throw new Error("GraphRenderer.init() must be called before renderNotes()");
    }

    this.clusterById.clear();
    this.noteById.clear();

    // Switch to note-level stylesheet
    this.cy.style(noteStylesheet());

    const elements: ElementsDefinition = {
      nodes: result.nodes.map((note) => {
        const nodeId = `note-${note.vault_path}`;
        this.noteById.set(nodeId, note);

        // Short filename label for display; truncated to keep nodes compact
        const shortLabel = note.title.length > 20
          ? note.title.slice(0, 18) + "…"
          : note.title;

        return {
          data: {
            id: nodeId,
            label: shortLabel,
            color: colorForType(note.dominant_type),
            vault_path: note.vault_path,
          },
        };
      }),

      edges: result.edges.map((edge, idx) => ({
        data: {
          id: `edge-${idx}`,
          source: `note-${edge.source}`,
          target: `note-${edge.target}`,
          edgeType: edge.type,
          weight: edge.weight,
          // Semantic edges are drawn thinner and dashed
          lineStyle: edge.type === "semantic" ? "dashed" : "solid",
          lineWidth: edge.type === "semantic" ? 0.8 : 1.5,
          opacity: edge.type === "semantic" ? 0.45 : 0.7,
        },
      })),
    };

    this.cy.elements().remove();
    this.cy.add(elements);

    // Apply per-edge data-driven styles via element-level data
    // (noteStylesheet handles base styles; override for semantic edges)
    this.cy.edges('[edgeType = "semantic"]').style({
      "line-style": "dashed",
      width: 0.8,
      opacity: 0.45,
    });
    this.cy.edges('[edgeType = "wikilink"]').style({
      "line-style": "solid",
      width: 1.5,
      opacity: 0.7,
    });

    // Bind click handlers on note nodes
    this.cy.nodes().on("tap", (evt) => {
      const node = evt.target as NodeSingular;
      const note = this.noteById.get(node.id());
      if (note) {
        this.callbacks.onNoteClick?.(note);
      }
    });

    // Run force-directed layout
    this.cy
      .layout({
        name: "cose",
        animate: true,
        animationDuration: 500,
        animationEasing: "ease-out",
        nodeRepulsion: () => 4500,
        nodeOverlap: 10,
        idealEdgeLength: () => 80,
        gravity: 0.3,
        numIter: 800,
        randomize: false,
        componentSpacing: 60,
      })
      .run();

    // Fit after layout
    this.cy.one("layoutstop", () => {
      this.cy?.fit(undefined, 40);
    });
  }

  // ---------------------------------------------------------------------------
  // Tooltip support
  // ---------------------------------------------------------------------------

  /**
   * Get the ClusterNode associated with a node at the given position.
   * Returns undefined if no node is found at that point.
   */
  getClusterAtPosition(
    x: number,
    y: number
  ): ClusterNode | undefined {
    if (!this.cy) return undefined;
    // Use Cytoscape's nodes filter to find the node closest to the rendered position
    const nodes = this.cy.nodes();
    const node = nodes.filter((n) => {
      const bb = n.renderedBoundingBox();
      return x >= bb.x1 && x <= bb.x2 && y >= bb.y1 && y <= bb.y2;
    }).first();
    if (node.length === 0) return undefined;
    return this.clusterById.get(node.id());
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resize the Cytoscape canvas when the container changes size. */
  resize(): void {
    this.cy?.resize();
    this.cy?.fit(undefined, 40);
  }

  /** Destroy the Cytoscape instance and clean up. */
  destroy(): void {
    this.cy?.destroy();
    this.cy = null;
    this.clusterById.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrap a label string at approximately `maxChars` characters per line.
   * Returns a string with newline characters suitable for Cytoscape's text-wrap.
   */
  private wrapLabel(label: string, maxChars: number): string {
    const words = label.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxChars) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);

    return lines.join("\n");
  }
}
