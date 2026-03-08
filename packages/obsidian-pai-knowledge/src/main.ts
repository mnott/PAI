/**
 * PAI Knowledge Graph — Obsidian Plugin Entry Point
 *
 * Registers:
 *   - Custom view type "pai-graph-view" (PaiGraphView)
 *   - Ribbon icon to open/reveal the graph view
 *   - Plugin settings tab (PaiSettingsTab)
 *   - Daemon client (PaiDaemonClient) — shared across all views
 *
 * The PaiDaemonClient is created on load and connected lazily (the view
 * calls connect() in onOpen()).  The plugin disconnects the client when
 * Obsidian unloads the plugin.
 */

import { Plugin, WorkspaceLeaf } from "obsidian";
import { PaiDaemonClient } from "./client/PaiDaemonClient";
import { PaiSettingsTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, PaiPluginSettings } from "./settings/SettingsDefaults";
import { PaiGraphView, VIEW_TYPE_PAI_GRAPH } from "./views/PaiGraphView";

export default class PaiKnowledgePlugin extends Plugin {
  settings!: PaiPluginSettings;
  client!: PaiDaemonClient;

  // ---------------------------------------------------------------------------
  // Plugin lifecycle
  // ---------------------------------------------------------------------------

  async onload(): Promise<void> {
    // 1. Load persisted settings (merged with defaults for forward-compat)
    await this.loadSettings();

    // 2. Create the daemon client (connection is deferred until a view opens)
    this.client = new PaiDaemonClient(this.settings.socketPath, 60_000);

    // 3. Register the custom view type
    this.registerView(
      VIEW_TYPE_PAI_GRAPH,
      (leaf: WorkspaceLeaf) => new PaiGraphView(leaf, this)
    );

    // 4. Add ribbon icon to open/reveal the graph view
    this.addRibbonIcon("brain-circuit", "PAI Knowledge Graph", async () => {
      await this.activateView();
    });

    // 5. Add command palette entry
    this.addCommand({
      id: "open-pai-knowledge-graph",
      name: "Open Knowledge Graph",
      callback: async () => {
        await this.activateView();
      },
    });

    // 5b. Trace an idea through time
    this.addCommand({
      id: "trace-idea",
      name: "Trace an idea through time",
      callback: async () => {
        // Activate the view first, then enter trace mode
        await this.activateView();
        // Give the view a tick to finish rendering, then prompt for a query
        setTimeout(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAI_GRAPH);
          if (leaves.length > 0) {
            const view = leaves[0].view;
            if (view instanceof PaiGraphView) {
              view.promptAndEnterTraceMode();
            }
          }
        }, 300);
      },
    });

    // 5c. Discover latent ideas
    this.addCommand({
      id: "latent-ideas",
      name: "Discover latent ideas",
      callback: async () => {
        // Activate the view first, then enter latent ideas mode
        await this.activateView();
        setTimeout(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAI_GRAPH);
          if (leaves.length > 0) {
            const view = leaves[0].view;
            if (view instanceof PaiGraphView) {
              view.enterLatentIdeasMode();
            }
          }
        }, 300);
      },
    });

    // 6. Register settings tab
    this.addSettingTab(new PaiSettingsTab(this.app, this));

    console.log("[PAI] Knowledge Graph plugin loaded");
  }

  async onunload(): Promise<void> {
    // Disconnect the daemon client cleanly when Obsidian closes or disables the plugin
    await this.client.disconnect().catch(() => {
      // Ignore disconnect errors on unload
    });
    console.log("[PAI] Knowledge Graph plugin unloaded");
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const stored = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // If the socket path changed, recreate the client with the new path
    if (this.client) {
      await this.client.disconnect().catch(() => {});
      this.client = new PaiDaemonClient(this.settings.socketPath, 60_000);
    }
  }

  // ---------------------------------------------------------------------------
  // View management
  // ---------------------------------------------------------------------------

  /**
   * Open the PAI graph view, or focus it if it is already open.
   * Prefers the right sidebar; falls back to a new leaf in the main editor area.
   */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;

    // Check if a leaf with our view type is already open
    let leaf: WorkspaceLeaf | null = null;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_PAI_GRAPH);

    if (existingLeaves.length > 0) {
      // Reveal the existing leaf
      leaf = existingLeaves[0];
    } else {
      // Open a new leaf — prefer right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      leaf = rightLeaf ?? workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_PAI_GRAPH,
        active: true,
      });
    }

    // Bring it into view
    workspace.revealLeaf(leaf);
  }
}
