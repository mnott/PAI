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
import type { ClusterNode, GraphClustersResult } from "../client/types";

export const VIEW_TYPE_PAI_GRAPH = "pai-graph-view";

export class PaiGraphView extends ItemView {
  private plugin: PaiKnowledgePlugin;
  private renderer: GraphRenderer | null = null;
  private state: GraphStateManager;
  private resizeObserver: ResizeObserver | null = null;

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

    // Level indicator
    this.toolbarEl.createSpan({
      cls: "pai-level-indicator",
      text: `Level ${snap.level}`,
    });
  }

  /** Initialise the Cytoscape renderer inside canvasEl */
  private initRenderer(): void {
    if (!this.canvasEl) return;
    this.renderer = new GraphRenderer(this.canvasEl, {
      onClusterClick: (cluster: ClusterNode) => {
        // For Phase 1 just push to Level 2 in state (renderer doesn't yet drill down)
        this.state.pushCluster(cluster);
        // Future: render Level 2 inside the same view
      },
      onBackgroundClick: () => {
        // Could deselect or show info panel
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
    }
    // Level 2 and Level 3 rendering will be added in Phase 2
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
