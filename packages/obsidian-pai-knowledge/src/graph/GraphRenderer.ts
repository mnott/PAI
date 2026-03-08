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
import type { ClusterNode, NoteNode, GraphNeighborhoodResult, GraphNoteContextResult, TraceEntry, GraphTraceResult } from "../client/types";
import { clusterStylesheet, noteStylesheet, traceStylesheet, colorForType } from "./GraphStyles";

// ---------------------------------------------------------------------------
// Public event callbacks
// ---------------------------------------------------------------------------

export interface GraphRendererCallbacks {
  /** Fired when the user single-clicks a cluster node */
  onClusterClick?: (cluster: ClusterNode) => void;
  /** Fired when the user single-clicks a note node (Level 2) */
  onNoteClick?: (note: NoteNode) => void;
  /**
   * Fired when the user single-clicks a neighbor note in Level 3 context view.
   * Allows replacing the focal note without leaving Level 3.
   */
  onNeighborClick?: (note: NoteNode) => void;
  /** Fired when the user taps the background (deselect) */
  onBackgroundClick?: () => void;
  /**
   * Fired when the user double-clicks the focal note in Level 3.
   * Intended for "Open in Obsidian" action.
   */
  onFocalDoubleClick?: (note: NoteNode) => void;
  /** Fired when the user clicks a trace entry node (Phase 4) */
  onTraceNodeClick?: (entry: TraceEntry) => void;
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
  /** The focal NoteNode in a Level 3 context view (null outside Level 3) */
  private focalNote: NoteNode | null = null;
  /** Map from cytoscape node id → TraceEntry for Phase 4 trace view */
  private traceEntryById = new Map<string, TraceEntry>();

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
  // Level 3: Note context view (full vault neighbourhood of a single note)
  // ---------------------------------------------------------------------------

  /**
   * Render the full 1-hop neighbourhood for a focal note across the entire vault.
   * The focal note appears as a larger, distinctly bordered node at the center.
   * Neighbor notes are arranged in a ring around it.
   *
   * Clicking a neighbor fires onNeighborClick (to replace the focal).
   * Double-clicking the focal fires onFocalDoubleClick (to open in Obsidian).
   *
   * @param result  GraphNoteContextResult from the daemon
   */
  renderNoteContext(result: GraphNoteContextResult): void {
    if (!this.cy) {
      throw new Error("GraphRenderer.init() must be called before renderNoteContext()");
    }

    this.clusterById.clear();
    this.noteById.clear();
    this.focalNote = result.focal;

    // Switch to note-level stylesheet
    this.cy.style(noteStylesheet());

    const focalId = `note-${result.focal.vault_path}`;

    // Focal node: larger (40px) with a distinctive white border
    const focalLabel = result.focal.title.length > 22
      ? result.focal.title.slice(0, 20) + "…"
      : result.focal.title;

    const elements: ElementsDefinition = {
      nodes: [
        // Focal node first
        {
          data: {
            id: focalId,
            label: focalLabel,
            color: colorForType(result.focal.dominant_type),
            vault_path: result.focal.vault_path,
            isFocal: "true",
            nodeSize: 40,
          },
        },
        // Neighbor nodes
        ...result.neighbors.map((note) => {
          const nodeId = `note-${note.vault_path}`;
          this.noteById.set(nodeId, note);

          const shortLabel = note.title.length > 20
            ? note.title.slice(0, 18) + "…"
            : note.title;

          return {
            data: {
              id: nodeId,
              label: shortLabel,
              color: colorForType(note.dominant_type),
              vault_path: note.vault_path,
              isFocal: "false",
              nodeSize: 28,
            },
          };
        }),
      ],

      edges: result.edges.map((edge, idx) => ({
        data: {
          id: `edge-${idx}`,
          source: `note-${edge.source}`,
          target: `note-${edge.target}`,
          edgeType: edge.type,
          weight: edge.weight,
        },
      })),
    };

    this.cy.elements().remove();
    this.cy.add(elements);

    // Style focal node distinctly: larger, white border
    this.cy.nodes(`[isFocal = "true"]`).style({
      width: 40,
      height: 40,
      "border-width": 3,
      "border-color": "#ffffff",
      "font-size": "12px",
      "z-index": 10,
    });

    // Neighbor nodes
    this.cy.nodes(`[isFocal = "false"]`).style({
      width: 28,
      height: 28,
    });

    // Edge styles
    this.cy.edges().style({
      "line-style": "solid",
      width: 1.5,
      opacity: 0.7,
    });

    // Bind click on neighbor nodes
    this.cy.nodes(`[isFocal = "false"]`).on("tap", (evt) => {
      const node = evt.target as NodeSingular;
      const note = this.noteById.get(node.id());
      if (note) {
        this.callbacks.onNeighborClick?.(note);
      }
    });

    // Bind double-click on focal node to open in Obsidian
    this.cy.nodes(`[isFocal = "true"]`).on("dblclick", () => {
      if (this.focalNote) {
        this.callbacks.onFocalDoubleClick?.(this.focalNote);
      }
    });

    // Background click
    this.cy.on("tap", (evt) => {
      if (evt.target === this.cy) {
        this.callbacks.onBackgroundClick?.();
      }
    });

    // Concentric layout: focal in center, neighbors in outer ring
    this.cy
      .layout({
        name: "concentric",
        animate: true,
        animationDuration: 500,
        animationEasing: "ease-out",
        concentric: (node: NodeSingular) => {
          // Focal node gets highest concentric level (center)
          return node.data("isFocal") === "true" ? 2 : 1;
        },
        levelWidth: () => 1,
        minNodeSpacing: 30,
        padding: 40,
        startAngle: Math.PI / 6,
        clockwise: true,
        equidistant: false,
        avoidOverlap: true,
      })
      .run();

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
    this.traceEntryById.clear();
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Trace (horizontal timeline) view
  // ---------------------------------------------------------------------------

  /**
   * Render a horizontal timeline of note appearances for a traced topic.
   *
   * Layout:
   *   - Nodes are positioned left-to-right proportionally to their indexed_at timestamp.
   *   - All nodes sit on the same horizontal axis (y = containerHeight / 2).
   *   - Temporal edges (grey arrows) flow left → right.
   *   - Wikilink edges (cyan dashed curves) arc above the timeline.
   *
   * @param result  GraphTraceResult from the daemon
   */
  renderTrace(result: GraphTraceResult): void {
    if (!this.cy) {
      throw new Error("GraphRenderer.init() must be called before renderTrace()");
    }

    this.clusterById.clear();
    this.noteById.clear();
    this.traceEntryById.clear();
    this.focalNote = null;

    // Switch to trace stylesheet
    this.cy.style(traceStylesheet());

    const entries = result.entries;
    if (entries.length === 0) {
      this.cy.elements().remove();
      return;
    }

    // Compute position x based on timestamp
    const containerWidth = this.container.offsetWidth || 800;
    const containerHeight = this.container.offsetHeight || 400;
    const PADDING = 80; // px from left/right edge
    const usableWidth = containerWidth - PADDING * 2;

    const minTime = result.time_span.from || entries[0].indexed_at;
    const maxTime = result.time_span.to || entries[entries.length - 1].indexed_at;
    const timeRange = maxTime - minTime || 1;

    const yCenter = containerHeight / 2;

    const elements: ElementsDefinition = {
      nodes: entries.map((entry, idx) => {
        const nodeId = `trace-${idx}`;
        this.traceEntryById.set(nodeId, entry);

        const x = PADDING + ((entry.indexed_at - minTime) / timeRange) * usableWidth;

        // Date label: YYYY-MM
        const date = entry.indexed_at > 0
          ? new Date(entry.indexed_at * 1000).toISOString().slice(0, 7)
          : "";
        const shortTitle = entry.title.length > 16
          ? entry.title.slice(0, 14) + "…"
          : entry.title;
        const label = `${shortTitle}\n${date}`;

        return {
          data: {
            id: nodeId,
            label,
            color: colorForType(entry.dominant_type),
          },
          position: { x, y: yCenter },
        };
      }),

      edges: result.connections.map((conn, idx) => {
        // Map path → nodeId via index lookup
        const fromIdx = entries.findIndex((e) => e.vault_path === conn.from_path);
        const toIdx = entries.findIndex((e) => e.vault_path === conn.to_path);
        if (fromIdx === -1 || toIdx === -1) return null;

        return {
          data: {
            id: `trace-edge-${idx}`,
            source: `trace-${fromIdx}`,
            target: `trace-${toIdx}`,
            edgeKind: conn.type,
          },
        };
      }).filter((e): e is NonNullable<typeof e> => e !== null),
    };

    this.cy.elements().remove();
    this.cy.add(elements);

    // Use preset layout (positions already set)
    this.cy.layout({ name: "preset" }).run();

    // Bind click handlers on trace nodes
    this.cy.nodes().on("tap", (evt) => {
      const node = evt.target as NodeSingular;
      const entry = this.traceEntryById.get(node.id());
      if (entry) {
        this.callbacks.onTraceNodeClick?.(entry);
      }
    });

    // Fit with generous padding so the timeline breathes
    this.cy.fit(undefined, 60);
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
