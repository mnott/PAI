/**
 * GraphStyles — Cytoscape stylesheet definitions for the PAI Knowledge Graph.
 *
 * Design principles:
 * - Dark-theme first; colours from Obsidian CSS variables where possible.
 * - Cluster nodes are rounded rectangles sized proportionally to their note count.
 * - Colour encodes the dominant_observation_type so recurring patterns are instantly readable.
 * - Edges (used at Level 2/3) are thin and muted to avoid visual noise.
 */

import type { StylesheetStyle } from "cytoscape";

// ---------------------------------------------------------------------------
// Observation-type → colour mapping
// ---------------------------------------------------------------------------

/**
 * Each observation type is assigned a colour.
 * These colours intentionally use high-contrast hues that work on both
 * light and dark backgrounds — the text is always white.
 */
export const OBSERVATION_TYPE_COLORS: Record<string, string> = {
  decision: "#06b6d4",   // cyan
  bugfix: "#ef4444",     // red
  feature: "#22c55e",    // green
  refactor: "#eab308",   // yellow
  discovery: "#3b82f6",  // blue
  change: "#a855f7",     // magenta / purple
  research: "#f97316",   // orange
  idea: "#ec4899",       // pink
  default: "#6b7280",    // grey fallback
};

/**
 * Returns the colour for a given observation type,
 * falling back to the 'default' grey.
 */
export function colorForType(observationType: string): string {
  return (
    OBSERVATION_TYPE_COLORS[observationType.toLowerCase()] ??
    OBSERVATION_TYPE_COLORS["default"]
  );
}

// ---------------------------------------------------------------------------
// Cytoscape stylesheets
// ---------------------------------------------------------------------------

/**
 * Cluster overview stylesheet (Level 1).
 * Nodes represent semantic clusters; no edges at this level.
 */
export function clusterStylesheet(): StylesheetStyle[] {
  return [
    // Base node style
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": "data(color)",
        "border-width": 0,
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "center",
        color: "#ffffff",
        "font-size": "data(fontSize)",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "font-weight": "bold",
        "text-wrap": "wrap",
        "text-max-width": "data(textMaxWidth)",
        "text-overflow-wrap": "whitespace",
        width: "data(width)",
        height: "data(height)",
        "transition-property": "background-color, border-color, opacity",
        "transition-duration": 150,
      },
    },
    // Hover: brighten + border
    {
      selector: "node:active",
      style: {
        "border-width": 2,
        "border-color": "#ffffff",
        opacity: 0.9,
      },
    },
    // Selected node
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": "#ffffff",
        "border-opacity": 1,
      },
    },
    // Suggest-index-note indicator: dashed border
    {
      selector: 'node[suggestIndex = "true"]',
      style: {
        "border-width": 2,
        "border-style": "dashed",
        "border-color": "#facc15",
        "border-opacity": 0.9,
      },
    },
    // Has-idea-note indicator: subtle glow via overlay
    {
      selector: 'node[hasIdea = "true"]',
      style: {
        "overlay-color": "#ec4899",
        "overlay-padding": 4,
        "overlay-opacity": 0.12,
      },
    },
  ];
}

/**
 * Trace-mode stylesheet (Phase 4 — horizontal timeline view).
 * Nodes are ellipses; temporal edges are thin grey arrows; wikilink edges are coloured curves.
 */
export function traceStylesheet(): StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        shape: "ellipse",
        "background-color": "data(color)",
        label: "data(label)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 6,
        color: "#e2e8f0",
        "font-size": 9,
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "text-wrap": "wrap",
        "text-max-width": "90px",
        width: 30,
        height: 30,
      },
    },
    {
      selector: 'edge[edgeKind = "temporal"]',
      style: {
        width: 1.5,
        "line-color": "#4b5563",
        "curve-style": "taxi",
        "taxi-direction": "rightward",
        opacity: 0.5,
        "target-arrow-shape": "triangle",
        "target-arrow-color": "#4b5563",
        "arrow-scale": 0.7,
      },
    },
    {
      selector: 'edge[edgeKind = "wikilink"]',
      style: {
        width: 1.5,
        "line-color": "#06b6d4",
        "curve-style": "unbundled-bezier",
        "control-point-distances": "-60",
        "control-point-weights": "0.5",
        opacity: 0.7,
        "target-arrow-shape": "triangle",
        "target-arrow-color": "#06b6d4",
        "arrow-scale": 0.8,
        "line-style": "dashed",
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 2,
        "border-color": "#ffffff",
        width: 38,
        height: 38,
      },
    },
  ];
}

/**
 * Note-level stylesheet (Level 2 — notes inside a cluster).
 * Nodes are smaller, edges represent vault wikilinks.
 */
export function noteStylesheet(): StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        shape: "ellipse",
        "background-color": "data(color)",
        label: "data(label)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 4,
        color: "#e2e8f0",
        "font-size": 10,
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "text-wrap": "ellipsis",
        "text-max-width": "80px",
        width: 28,
        height: 28,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": "#4b5563",
        "curve-style": "bezier",
        opacity: 0.6,
        "target-arrow-shape": "none",
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 2,
        "border-color": "#ffffff",
        width: 36,
        height: 36,
      },
    },
  ];
}
