/**
 * SettingsTab — Obsidian plugin settings panel for PAI Knowledge Graph.
 *
 * Settings exposed:
 *   - Unix socket path (text input)
 *   - Test connection button with live status indicator
 *   - Min cluster size (slider)
 *   - Max clusters (slider)
 *   - Lookback window in days (slider)
 *   - Similarity threshold (slider)
 */

import { App, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type PaiKnowledgePlugin from "../main";

export class PaiSettingsTab extends PluginSettingTab {
  plugin: PaiKnowledgePlugin;

  constructor(app: App, plugin: PaiKnowledgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "PAI Knowledge Graph" });

    // ------------------------------------------------------------------
    // Section: Daemon Connection
    // ------------------------------------------------------------------
    containerEl.createEl("h3", {
      text: "Daemon Connection",
      cls: "pai-settings-section-heading",
    });

    // Socket path
    new Setting(containerEl)
      .setName("Unix socket path")
      .setDesc(
        "Path to the PAI daemon socket. Start the daemon with `pai daemon start`."
      )
      .addText((text) => {
        text
          .setPlaceholder("/tmp/pai.sock")
          .setValue(this.plugin.settings.socketPath)
          .onChange(async (value) => {
            this.plugin.settings.socketPath = value.trim() || "/tmp/pai.sock";
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "260px";
      });

    // Test connection button + status indicator
    let statusEl: HTMLElement | null = null;
    let retryBtn: ButtonComponent | null = null;

    const connectionRow = new Setting(containerEl)
      .setName("Connection status")
      .setDesc("Verify that the PAI daemon is reachable on the configured socket path.");

    connectionRow.addButton((btn) => {
      retryBtn = btn;
      btn
        .setButtonText("Test connection")
        .setCta()
        .onClick(async () => {
          if (!statusEl) return;
          statusEl.className = "pai-connection-status testing";
          statusEl.innerHTML = '<span class="pai-connection-dot"></span> Testing…';
          btn.setDisabled(true);

          try {
            const ok = await this.plugin.client.isConnected();
            if (ok) {
              statusEl.className = "pai-connection-status connected";
              statusEl.innerHTML =
                '<span class="pai-connection-dot"></span> Connected';
            } else {
              statusEl.className = "pai-connection-status disconnected";
              statusEl.innerHTML =
                '<span class="pai-connection-dot"></span> Not reachable — run `pai daemon start`';
            }
          } catch {
            statusEl.className = "pai-connection-status disconnected";
            statusEl.innerHTML =
              '<span class="pai-connection-dot"></span> Error during probe';
          } finally {
            btn.setDisabled(false);
          }
        });
    });

    // Inject status element beneath the setting row
    statusEl = connectionRow.settingEl.createDiv({
      cls: "pai-connection-status disconnected",
    });
    statusEl.innerHTML =
      '<span class="pai-connection-dot"></span> Not tested yet';

    // ------------------------------------------------------------------
    // Section: Graph Behaviour
    // ------------------------------------------------------------------
    containerEl.createEl("h3", {
      text: "Graph Behaviour",
      cls: "pai-settings-section-heading",
    });

    // Min cluster size
    const minSizeDesc = this.createRangeDesc(
      "Minimum cluster size",
      this.plugin.settings.minClusterSize,
      "notes"
    );
    new Setting(containerEl)
      .setName("Minimum cluster size")
      .setDesc(minSizeDesc.fragment)
      .addSlider((slider) => {
        slider
          .setLimits(2, 10, 1)
          .setValue(this.plugin.settings.minClusterSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minClusterSize = value;
            minSizeDesc.update(value);
            await this.plugin.saveSettings();
          });
      });

    // Max clusters
    const maxClustersDesc = this.createRangeDesc(
      "Maximum clusters",
      this.plugin.settings.maxClusters,
      "clusters"
    );
    new Setting(containerEl)
      .setName("Maximum clusters")
      .setDesc(maxClustersDesc.fragment)
      .addSlider((slider) => {
        slider
          .setLimits(5, 50, 1)
          .setValue(this.plugin.settings.maxClusters)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxClusters = value;
            maxClustersDesc.update(value);
            await this.plugin.saveSettings();
          });
      });

    // Lookback days
    const lookbackDesc = this.createRangeDesc(
      "Lookback window",
      this.plugin.settings.lookbackDays,
      "days"
    );
    new Setting(containerEl)
      .setName("Lookback window")
      .setDesc(lookbackDesc.fragment)
      .addSlider((slider) => {
        slider
          .setLimits(7, 365, 7)
          .setValue(this.plugin.settings.lookbackDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.lookbackDays = value;
            lookbackDesc.update(value);
            await this.plugin.saveSettings();
          });
      });

    // Similarity threshold
    const simDesc = this.createRangeDesc(
      "Similarity threshold",
      this.plugin.settings.similarityThreshold,
      ""
    );
    new Setting(containerEl)
      .setName("Similarity threshold")
      .setDesc(simDesc.fragment)
      .addSlider((slider) => {
        slider
          .setLimits(0.3, 0.9, 0.05)
          .setValue(this.plugin.settings.similarityThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.similarityThreshold = value;
            simDesc.update(value);
            await this.plugin.saveSettings();
          });
      });

    // Tip
    containerEl.createEl("p", {
      text: "Lower similarity = larger, broader clusters. Higher similarity = smaller, tighter clusters.",
      cls: "setting-item-description",
    });
  }

  /**
   * Creates a DocumentFragment for a slider description that shows the live value.
   * Returns both the fragment to pass to setDesc() and an update() callback
   * that re-renders the value span when the slider moves.
   */
  private createRangeDesc(
    label: string,
    initial: number,
    unit: string
  ): { fragment: DocumentFragment; update: (v: number) => void } {
    const fragment = document.createDocumentFragment();
    const valueSpan = document.createElement("strong");
    valueSpan.textContent = `${initial}${unit ? " " + unit : ""}`;
    fragment.append(`Current value: `);
    fragment.append(valueSpan);

    return {
      fragment,
      update: (v: number) => {
        valueSpan.textContent = `${v}${unit ? " " + unit : ""}`;
      },
    };
  }
}
