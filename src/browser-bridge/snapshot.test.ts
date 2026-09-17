/**
 * Tests for the snapshot YAML builder: shape (roles, quoted names, brackets),
 * the s1,s2,… ref sequence in DOM order, refMap correctness, no refs for
 * non-interactive elements, and per-snapshot ref isolation.
 *
 * Imports the extension's snapshot.js directly — it is the single source of
 * truth for the format, shared with background.js.
 */

import { describe, it, expect } from "vitest";
import { buildSnapshot, type SnapshotNode } from "../../extensions/browser-bridge/snapshot.js";

/** The spec's example page, as a distilled CDP tree. */
function exampleTree(): SnapshotNode {
  return {
    nodeId: 1,
    nodeName: "#document",
    nodeType: 9,
    attrs: { name: "Example Domain" },
    children: [
      {
        nodeId: 2,
        nodeName: "DIV",
        nodeType: 1,
        attrs: {},
        children: [
          {
            nodeId: 3,
            nodeName: "H1",
            nodeType: 1,
            attrs: {},
            children: [
              { nodeId: 4, nodeName: "#text", nodeType: 3, attrs: { text: "Example Domain" }, children: [] },
            ],
          },
          {
            nodeId: 5,
            nodeName: "A",
            nodeType: 1,
            attrs: { href: "https://example.org" },
            children: [
              { nodeId: 6, nodeName: "#text", nodeType: 3, attrs: { text: "More information..." }, children: [] },
            ],
          },
          {
            nodeId: 7,
            nodeName: "INPUT",
            nodeType: 1,
            attrs: { type: "search", placeholder: "Search" },
            children: [],
          },
          {
            nodeId: 8,
            nodeName: "BUTTON",
            nodeType: 1,
            attrs: {},
            children: [
              { nodeId: 9, nodeName: "#text", nodeType: 3, attrs: { text: "Go" }, children: [] },
            ],
          },
        ],
      },
    ],
  };
}

describe("buildSnapshot", () => {
  it("renders the a11y-tree YAML: lowercase roles, quoted names, bracket attrs, 2-space depth", () => {
    const { yaml } = buildSnapshot(exampleTree());
    expect(yaml).toBe(
      [
        '- document "Example Domain":',
        '  - heading "Example Domain" [level=1]',
        '  - link "More information..." [ref=s1]',
        '  - textbox "Search" [ref=s2]',
        '  - button "Go" [ref=s3]',
      ].join("\n")
    );
  });

  it("assigns refs s1,s2,… in DOM order and maps every ref to its nodeId", () => {
    const { refMap } = buildSnapshot(exampleTree());
    expect(refMap).toEqual({ s1: 5, s2: 7, s3: 8 });
  });

  it("gives non-interactive elements no ref", () => {
    const { yaml, refMap } = buildSnapshot(exampleTree());
    expect(yaml).not.toMatch(/heading[^\n]*ref=/);
    expect(yaml).not.toMatch(/document[^\n]*ref=/);
    expect(Object.keys(refMap)).toEqual(["s1", "s2", "s3"]);
  });

  it("treats unlabeled generic containers as transparent (children move up)", () => {
    const { yaml } = buildSnapshot(exampleTree());
    expect(yaml).not.toMatch(/text ""/); // the wrapping DIV emits no line
    expect(yaml.split("\n")[1].startsWith("  - heading")).toBe(true); // depth 1, not 2
  });

  it("starts a fresh counter per snapshot (refs are not comparable across snapshots)", () => {
    const first = buildSnapshot(exampleTree());
    expect(first.refMap.s1).toBe(5); // the link

    // Remove the link: the textbox is now the first interactive element.
    const tree = exampleTree();
    tree.children![0].children!.splice(1, 1);
    const second = buildSnapshot(tree);
    expect(second.yaml).toContain('- textbox "Search" [ref=s1]');
    expect(second.refMap.s1).toBe(7); // same ref id, different node — per-snapshot scope
    expect(first.refMap.s1).toBe(5); // first snapshot untouched
  });

  it("honours aria-label over text content, and explicit role attributes", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        {
          nodeId: 2,
          nodeName: "DIV",
          nodeType: 1,
          attrs: { role: "tab", "aria-label": "Details" },
          children: [],
        },
      ],
    };
    const { yaml, refMap } = buildSnapshot(tree);
    expect(yaml).toContain('- tab "Details" [ref=s1]');
    expect(refMap).toEqual({ s1: 2 });
  });

  it("gives tabindex-carrying generic elements a ref", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        {
          nodeId: 4,
          nodeName: "SPAN",
          nodeType: 1,
          attrs: { tabindex: "0", "aria-label": "Open menu" },
          children: [],
        },
      ],
    };
    const { yaml, refMap } = buildSnapshot(tree);
    expect(yaml).toContain('- text "Open menu" [ref=s1]');
    expect(refMap).toEqual({ s1: 4 });
  });

  it("maps input types to checkbox/radio/slider and escapes quotes in names", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "Form" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "checkbox", "aria-label": 'Accept "terms"' }, children: [] },
        { nodeId: 3, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "choice" }, children: [] },
        { nodeId: 4, nodeName: "INPUT", nodeType: 1, attrs: { type: "range", "aria-label": "Volume" }, children: [] },
        { nodeId: 5, nodeName: "SELECT", nodeType: 1, attrs: { "aria-label": "Size" }, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toContain('- checkbox "Accept \\"terms\\"" [ref=s1]');
    expect(yaml).toContain('- radio "choice" [ref=s2]');
    expect(yaml).toContain('- slider "Volume" [ref=s3]');
    expect(yaml).toContain('- combobox "Size" [ref=s4]');
  });

  it("renders a labeled generic as a text line, unlabeled empty generics are dropped", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        { nodeId: 2, nodeName: "P", nodeType: 1, attrs: {}, children: [
          { nodeId: 3, nodeName: "#text", nodeType: 3, attrs: { text: "Just a paragraph" }, children: [] },
        ] },
        { nodeId: 4, nodeName: "SPAN", nodeType: 1, attrs: {}, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toBe(['- document "T":', '  - text "Just a paragraph"'].join("\n"));
  });
});
