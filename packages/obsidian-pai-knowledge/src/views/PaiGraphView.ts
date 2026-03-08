/**
 * PaiGraphView — the main ItemView that hosts the PAI Knowledge Graph.
 *
 * Lifecycle:
 *   onOpen()  → connect to daemon, build UI shell, load clusters, render
 *   onClose() → disconnect client, destroy renderer, clean up ResizeObserver
 *
 * UI layout:
 *   ┌─────────────────────────────────────────┐
 *   │ .pai-graph-toolbar  (breadcrumbs + back) │
 *   ├─────────────────────────────────────────┤
 *   │ .pai-cytoscape-canvas                   │
 *   │   (Cytoscape renders here)              │
 *   └─────────────────────────────────────────┘
 *
 * States (overlaid on the canvas):
 *   .pai-loading     — connecting / fetching data
 *   .pai-error-state — daemon not running or RPC failure
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type PaiKnowledgePlugin from "../main";
import { GraphRenderer } from "../graph/GraphRenderer";
import { GraphStateManager } from "../state/GraphStateManager";
import type {
  ClusterNode,
  GraphClustersResult,
  GraphNeighborhoodResult,
  GraphNoteContextResult,
  GraphTraceResult,
  NoteNode,
  TraceEntry,
} from "../client/types";

export const VIEW_TYPE_PAI_GRAPH = "pai-graph-view";

export class PaiGraphView extends ItemView {
  private plugin: PaiKnowledgePlugin;
  private renderer: GraphRenderer | null = null;
  private state: GraphStateManager;
  private resizeObserver: ResizeObserver | null = null;

  /** When true, the view is showing a trace timeline instead of the level graph */
  private traceMode = false;
  /** The current trace query, set when entering trace mode */
  private traceQuery = "";

  // DOM refs
  private toolbarEl: HTMLElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PaiKnowledgePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = new GraphStateManager();
  }

  // ---------------------------------------------------------------------------
  // ItemView interface
  // ---------------------------------------------------------------------------

  getViewType(): string {
    return VIEW_TYPE_PAI_GRAPH;
  }

  getDisplayText(): string {
    return "PAI Knowledge Graph";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("pai-graph-container");

    // Build skeleton UI
    this.toolbarEl = root.createDiv({ cls: "pai-graph-toolbar" });
    this.canvasEl = root.createDiv({ cls: "pai-cytoscape-canvas" });

    this.renderToolbar();

    // Subscribe to navigation state changes
    this.state.on("change", () => this.renderToolbar());

    // Show loading overlay while we connect + fetch
    this.showLoading("Connecting to PAI daemon…");

    // Connect to daemon
    try {
      await this.plugin.client.connect();
    } catch (err) {
      this.showError(
        "PAI daemon not running",
        "Could not connect to the PAI daemon. Start it with:",
        "pai daemon start"
      );
      return;
    }

    // Fetch clusters
    let result: GraphClustersResult;
    try {
      this.showLoading("Loading knowledge clusters…");
      result = await this.plugin.client.call<GraphClustersResult>(
        "graph_clusters",
        {
          min_size: this.plugin.settings.minClusterSize,
          max_clusters: this.plugin.settings.maxClusters,
          lookback_days: this.plugin.settings.lookbackDays,
          similarity_threshold: this.plugin.settings.similarityThreshold,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError(
        "Failed to load clusters",
        message,
        "Check that `pai daemon start` is running and try again."
      );
      return;
    }

    // Hide overlay, initialise renderer, render
    this.hideOverlay();
    this.initRenderer();
    this.renderLevel1(result.clusters);

    // Watch container for resize events
    if (window.ResizeObserver && this.canvasEl) {
      this.resizeObserver = new ResizeObserver(() => {
        this.renderer?.resize();
      });
      this.resizeObserver.observe(this.canvasEl);
    }
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.destroy();
    this.renderer = null;
    // Disconnect daemon client if this is the last open view
    // (plugin itself manages the client; we just leave it open)
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /** Build the toolbar: back button + breadcrumbs + level indicator */
  private renderToolbar(): void {
    if (!this.toolbarEl) return;
    this.toolbarEl.empty();

    const snap = this.state.snapshot();

    // Back button (hidden at Level 1)
    if (snap.canGoBack) {
      const backBtn = this.toolbarEl.createEl("button", {
        cls: "pai-back-btn",
        text: "← Back",
      });
      backBtn.addEventListener("click", () => {
        this.state.pop();
        this.onNavigationChange();
      });
    }

    // Breadcrumb
    const crumbEl = this.toolbarEl.createDiv({ cls: "pai-breadcrumb" });
    snap.breadcrumbs.forEach((crumb, idx) => {
      if (idx > 0) {
        crumbEl.createSpan({
          cls: "pai-breadcrumb-separator",
          text: " › ",
        });
      }
      const isLast = idx === snap.breadcrumbs.length - 1;
      const crumbItem = crumbEl.createSpan({
        cls: isLast ? "" : "pai-breadcrumb-item",
        text: crumb,
      });
      if (!isLast) {
        crumbItem.addEventListener("click", () => {
          this.state.navigateTo(idx);
          this.onNavigationChange();
        });
      }
    });

    if (this.traceMode) {
      // In trace mode: show "Back to Graph" and the query label
      const backToGraphBtn = this.toolbarEl.createEl("button", {
        cls: "pai-back-btn",
        text: "← Graph",
      });
      backToGraphBtn.addEventListener("click", () => {
        this.exitTraceMode();
      });

      this.toolbarEl.createSpan({
        cls: "pai-trace-label",
        text: `Timeline: "${this.traceQuery}"`,
      });
    } else {
      // Level indicator
      this.toolbarEl.createSpan({
        cls: "pai-level-indicator",
        text: `Level ${snap.level}`,
      });

      // Trace button — always visible when not in trace mode
      const traceBtn = this.toolbarEl.createEl("button", {
        cls: "pai-trace-btn",
        text: "Trace",
      });
      traceBtn.setAttribute("title", "Trace an idea through time");
      traceBtn.addEventListener("click", () => {
        this.promptAndEnterTraceMode();
      });
    }
  }

  /** Initialise the Cytoscape renderer inside canvasEl */
  private initRenderer(): void {
    if (!this.canvasEl) return;
    this.renderer = new GraphRenderer(this.canvasEl, {
      onClusterClick: (cluster: ClusterNode) => {
        this.state.pushCluster(cluster);
        this.onNavigationChange();
      },
      onNoteClick: (note: NoteNode) => {
        // Level 2 note clicked — drill into Level 3 note context
        const snap = this.state.snapshot();
        if (snap.level === 2 && snap.context.level === 2) {
          // Synthesize a ClusterNoteRef from the NoteNode
          this.state.pushNote(snap.context.cluster, {
            vault_path: note.vault_path,
            title: note.title,
            indexed_at: note.updated_at,
          });
          this.onNavigationChange();
        }
      },
      onNeighborClick: (note: NoteNode) => {
        // Level 3 neighbor clicked — replace focal note with this one
        const snap = this.state.snapshot();
        if (snap.level === 3 && snap.context.level === 3) {
          // Pop back to Level 2 context, then push the new note
          this.state.pop();
          const snap2 = this.state.snapshot();
          if (snap2.level === 2 && snap2.context.level === 2) {
            this.state.pushNote(snap2.context.cluster, {
              vault_path: note.vault_path,
              title: note.title,
              indexed_at: note.updated_at,
            });
            this.onNavigationChange();
          }
        }
      },
      onFocalDoubleClick: (note: NoteNode) => {
        // Open the focal note in Obsidian
        this.app.workspace.openLinkText(note.vault_path, "", false);
      },
      onBackgroundClick: () => {
        // Could deselect or show info panel
      },
      onTraceNodeClick: (entry: TraceEntry) => {
        // Open the traced note in Obsidian
        this.app.workspace.openLinkText(entry.vault_path, "", false);
      },
    });
    this.renderer.init();
  }

  /** Render the Level 1 cluster overview */
  private renderLevel1(clusters: ClusterNode[]): void {
    if (!this.renderer) return;
    if (clusters.length === 0) {
      this.showError(
        "No clusters found",
        "The PAI daemon returned no clusters for the current settings.",
        "Try lowering the minimum cluster size or extending the lookback window."
      );
      return;
    }
    this.renderer.renderClusters(clusters);
  }

  /** Called after any navigation state change — re-renders the appropriate level */
  private onNavigationChange(): void {
    const snap = this.state.snapshot();
    if (snap.level === 1) {
      // Reload clusters when navigating back to the overview
      this.reloadClusters();
    } else if (snap.level === 2) {
      // Drill down into the selected cluster
      const ctx = snap.context;
      if (ctx.level === 2) {
        this.loadAndRenderNeighborhood(ctx.cluster);
      }
    } else if (snap.level === 3) {
      // Show the full vault neighbourhood for the selected note
      const ctx = snap.context;
      if (ctx.level === 3) {
        this.loadAndRenderNoteContext(ctx.note.vault_path);
      }
    }
  }

  /** Reload cluster data from the daemon and re-render */
  private async reloadClusters(): Promise<void> {
    this.showLoading("Refreshing clusters…");
    try {
      const result = await this.plugin.client.call<GraphClustersResult>(
        "graph_clusters",
        {
          min_size: this.plugin.settings.minClusterSize,
          max_clusters: this.plugin.settings.maxClusters,
          lookback_days: this.plugin.settings.lookbackDays,
          similarity_threshold: this.plugin.settings.similarityThreshold,
        }
      );
      this.hideOverlay();
      this.renderLevel1(result.clusters);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError("Refresh failed", message, "pai daemon start");
    }
  }

  /**
   * Fetch neighbourhood data for the given cluster and render Level 2.
   * Extracts vault_paths from the cluster's notes array.
   */
  private async loadAndRenderNeighborhood(cluster: ClusterNode): Promise<void> {
    this.showLoading(`Loading notes for "${cluster.label}"…`);

    const vaultPaths = cluster.notes.map((n) => n.vault_path);

    let result: GraphNeighborhoodResult;
    try {
      result = await this.plugin.client.call<GraphNeighborhoodResult>(
        "graph_neighborhood",
        {
          vault_paths: vaultPaths,
          project_id: this.plugin.settings.projectId ?? 0,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError("Failed to load cluster notes", message, "pai daemon start");
      return;
    }

    this.hideOverlay();

    if (!this.renderer) return;

    if (result.nodes.length === 0) {
      this.showError(
        "No notes found",
        `The cluster "${cluster.label}" has no indexed notes.`,
        "Try re-indexing with: pai index"
      );
      return;
    }

    this.renderer.renderNotes(result);
  }

  /**
   * Fetch the full vault neighbourhood for a single note and render Level 3.
   * Crosses cluster boundaries — shows ALL notes linked to/from this note.
   */
  private async loadAndRenderNoteContext(vaultPath: string): Promise<void> {
    const displayName = vaultPath.split("/").pop()?.replace(/\.md$/i, "") ?? vaultPath;
    this.showLoading(`Loading connections for "${displayName}"…`);

    let result: GraphNoteContextResult;
    try {
      result = await this.plugin.client.call<GraphNoteContextResult>(
        "graph_note_context",
        {
          vault_path: vaultPath,
          project_id: this.plugin.settings.projectId ?? 0,
          max_neighbors: 50,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError("Failed to load note context", message, "pai daemon start");
      return;
    }

    this.hideOverlay();

    if (!this.renderer) return;

    if (result.neighbors.length === 0) {
      this.showError(
        "No connections found",
        `"${displayName}" has no wikilinks to or from other notes.`,
        "Add [[wikilinks]] in the note to connect it to the vault."
      );
      return;
    }

    this.renderer.renderNoteContext(result);

    // Add "Open in Obsidian" button to the toolbar after rendering
    this.addOpenInObsidianButton(vaultPath);
  }

  /**
   * Adds an "Open in Obsidian" button to the toolbar for Level 3 context.
   * Appended after the breadcrumb — removed automatically on the next renderToolbar() call.
   */
  private addOpenInObsidianButton(vaultPath: string): void {
    if (!this.toolbarEl) return;
    const btn = this.toolbarEl.createEl("button", {
      cls: "pai-open-btn",
      text: "Open Note",
    });
    btn.addEventListener("click", () => {
      this.app.workspace.openLinkText(vaultPath, "", false);
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Trace mode
  // ---------------------------------------------------------------------------

  /**
   * Prompt the user for a search query, then enter trace mode.
   * Uses a simple browser prompt() as Obsidian's SuggestModal requires subclassing
   * which is acceptable for a one-shot input here.
   */
  promptAndEnterTraceMode(): void {
    const query = window.prompt("Trace an idea: enter a keyword or topic to follow through time");
    if (!query || !query.trim()) return;
    this.enterTraceMode(query.trim());
  }

  /** Enter trace mode for the given query. */
  async enterTraceMode(query: string): Promise<void> {
    this.traceMode = true;
    this.traceQuery = query;
    this.renderToolbar();
    await this.loadAndRenderTrace(query);
  }

  /** Exit trace mode and return to the current navigation level. */
  private exitTraceMode(): void {
    this.traceMode = false;
    this.traceQuery = "";
    this.renderToolbar();
    // Re-render the graph at the current navigation level
    this.onNavigationChange();
  }

  /** Fetch graph_trace data and render the horizontal timeline. */
  private async loadAndRenderTrace(query: string): Promise<void> {
    this.showLoading(`Tracing "${query}" through time…`);

    let result: GraphTraceResult;
    try {
      result = await this.plugin.client.call<GraphTraceResult>(
        "graph_trace",
        {
          query,
          project_id: this.plugin.settings.projectId ?? 0,
          max_results: 30,
          lookback_days: this.plugin.settings.lookbackDays ?? 365,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError("Trace failed", message, "pai daemon start");
      return;
    }

    this.hideOverlay();

    if (!this.renderer) return;

    if (result.entries.length === 0) {
      this.showError(
        "Nothing found",
        `No notes mention "${query}" in the last ${this.plugin.settings.lookbackDays ?? 365} days.`,
        "Try a different keyword or extend the lookback window in settings."
      );
      return;
    }

    this.renderer.renderTrace(result);
  }

  // ---------------------------------------------------------------------------
  // Overlay helpers
  // ---------------------------------------------------------------------------

  private showLoading(message: string): void {
    this.removeOverlay();
    if (!this.canvasEl) return;

    const overlay = this.canvasEl.createDiv({ cls: "pai-loading" });
    overlay.createDiv({ cls: "pai-loading-spinner" });
    overlay.createDiv({ cls: "pai-loading-message", text: message });
    this.overlayEl = overlay;
  }

  private showError(
    title: string,
    message: string,
    hint?: string
  ): void {
    this.removeOverlay();
    if (!this.canvasEl) return;

    const overlay = this.canvasEl.createDiv({ cls: "pai-error-state" });
    overlay.createDiv({ cls: "pai-error-icon", text: "⚡" });
    overlay.createDiv({ cls: "pai-error-title", text: title });
    overlay.createDiv({ cls: "pai-error-message", text: message });

    if (hint) {
      overlay.createDiv({ cls: "pai-error-hint", text: hint });
    }

    const retryBtn = overlay.createEl("button", {
      cls: "pai-retry-btn",
      text: "Retry",
    });
    retryBtn.addEventListener("click", () => {
      this.state.reset();
      this.onOpen();
    });

    this.overlayEl = overlay;
  }

  private hideOverlay(): void {
    this.removeOverlay();
  }

  private removeOverlay(): void {
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }
}
