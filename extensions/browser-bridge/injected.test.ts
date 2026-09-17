/**
 * Unit tests for the page-injected functions (injected.js) against a
 * hand-built fake DOM. These functions run in the page via
 * chrome.scripting.executeScript, so they must stay self-contained — which
 * is also what lets them run here with just a few fake globals.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  walkDom,
  clickByPath,
  typeByPath,
  evalInPage,
  installConsoleHook,
  readConsole,
} from "./injected.js";

// Subclass the REAL Event (replacing globalThis.Event breaks Node internals).
class FakePointerEvent extends Event {}
class FakeMouseEvent extends Event {}

interface FakeEl {
  tagName: string;
  nodeName: string;
  nodeType: number;
  children: FakeEl[];
  attributes: { name: string; value: string }[];
  nodeValue?: string;
  isContentEditable?: boolean;
  value?: string;
  events: string[];
  clicked: number;
  scrolled?: boolean;
  focused?: boolean;
  execCommandResult?: boolean;
}

function el(tagName: string, attrs: Record<string, string> = {}, extra: Partial<FakeEl> = {}): FakeEl {
  const node = {
    tagName,
    nodeName: tagName,
    nodeType: 1,
    children: [],
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    events: [],
    clicked: 0,
    ...extra,
  } as unknown as FakeEl & {
    scrollIntoView(): void;
    focus(): void;
    click(): void;
    dispatchEvent(e: Event): void;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  };
  (node as unknown as Record<string, unknown>).scrollIntoView = () => ((node as unknown as Record<string, unknown>).scrolled = true);
  (node as unknown as Record<string, unknown>).focus = () => ((node as unknown as Record<string, unknown>).focused = true);
  node.click = () => node.clicked++;
  node.dispatchEvent = (e: Event) => node.events.push(e.type);
  node.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 50 });
  return node;
}

function text(t: string): FakeEl {
  return { tagName: "#text", nodeName: "#text", nodeType: 3, nodeValue: t, children: [], attributes: [], events: [], clicked: 0 };
}

let editableExecArgs: [string, string] | null = null;

const page = {
  root: el("HTML"),
  anchor: el("A", { href: "https://example.com/", "aria-label": "link" }),
  editor: el("DIV", { role: "textbox" }, { isContentEditable: true }),
  div: el("DIV", {}, {}),
  window: {} as Record<string, unknown>,
  document: {} as Record<string, unknown>,
};

beforeAll(() => {
  const body = el("BODY");
  page.root.children.push(body);
  body.children.push(page.anchor, page.div, page.editor);
  page.anchor.children.push(text("  spaced   text  "));

  // The few page globals the injected functions touch.
  const g = globalThis as unknown as Record<string, unknown>;
  g.PointerEvent = FakePointerEvent;
  g.MouseEvent = FakeMouseEvent;
  g.window = page.window;
  g.document = page.document;
  page.document.documentElement = page.root;
  page.document.title = "T";
  page.document.execCommand = (cmd: string, _show: boolean, value: string) => {
    editableExecArgs = [cmd, value];
    return page.editor.execCommandResult ?? true;
  };
});

describe("walkDom", () => {
  it("distills the tree, skips script/style, records index paths", () => {
    const script = el("SCRIPT");
    page.div.children.push(script, el("BUTTON", { type: "button" }));
    const { tree, paths } = walkDom();

    expect(tree.nodeName).toBe("#document");
    expect(tree.attrs.name).toBe("T"); // document.title becomes the name
    // html/body are transparent in yaml but present in the tree
    const html = tree.children[0];
    expect(html.nodeName).toBe("HTML");
    const body = html.children[0];
    expect(body.nodeName).toBe("BODY");

    const anchorNode = body.children[0];
    expect(anchorNode.nodeName).toBe("A");
    expect(anchorNode.attrs.href).toBe("https://example.com/");
    expect(anchorNode.children[0].attrs.text).toBe("spaced text"); // whitespace collapsed

    const button = body.children[1].children[0]; // div's children: script skipped
    expect(button.nodeName).toBe("BUTTON");

    // paths use RAW child indices under documentElement: the skipped SCRIPT
    // still occupies index 0 in div, so the button is [0,1,1].
    expect(paths[anchorNode.nodeId]).toEqual([0, 0]);
    expect(paths[button.nodeId]).toEqual([0, 1, 1]);
  });
});

describe("clickByPath", () => {
  it("scrolls and clicks the element at a path", () => {
    const r = clickByPath([0, 0]);
    expect(r.clicked).toBe(true);
    expect(page.anchor.clicked).toBe(1);
    expect(page.anchor.scrolled).toBe(true);
  });

  it("reports stale paths loudly", () => {
    expect(clickByPath([9, 9])).toMatchObject({ clicked: false, error: expect.stringContaining("stale ref") });
  });

  it("falls back to dispatched pointer events when click() is missing", () => {
    const custom = el("X-BUTTON");
    (custom as unknown as Record<string, unknown>).click = undefined;
    page.div.children.push(custom);
    const r = clickByPath([0, 1, 2]); // after script(0) and button(1)
    expect(r.clicked).toBe(true);
    expect(custom.events).toEqual(["pointerdown", "pointerup", "click"]); // exactly one click
  });
});

describe("typeByPath", () => {
  it("appends via the value property and fires input + change", () => {
    const field = el("INPUT", { type: "text" });
    field.value = "ab";
    page.div.children.push(field);
    const r = typeByPath([0, 1, 3], "cd"); // after script(0), button(1), custom(2)
    expect(r.typed).toBe(true);
    expect(field.value).toBe("abcd");
    expect(field.events).toEqual(["input", "change"]);
    expect(field.focused).toBe(true);
  });

  it("inserts text at the caret for contenteditable elements", () => {
    const r = typeByPath([0, 2], "typed");
    expect(r.typed).toBe(true);
    expect(editableExecArgs).toEqual(["insertText", "typed"]);
  });

  it("refuses non-typable elements loudly", () => {
    const r = typeByPath([0, 1], "x"); // plain div
    expect(r.typed).toBe(false);
    expect(r.error).toMatch(/not typable/);
  });
});

describe("evalInPage", () => {
  it("returns values pre-sanitized to JSON", () => {
    expect(evalInPage("2 + 3")).toEqual({ ok: true, value: 5 });
    expect(evalInPage("({ a: 1 })")).toEqual({ ok: true, value: { a: 1 } });
    expect(evalInPage("undefined")).toEqual({ ok: true, value: null });
  });

  it("reports thrown errors", () => {
    expect(evalInPage("throw new Error('nope')")).toMatchObject({ ok: false, error: "nope" });
  });
});

describe("console hook", () => {
  it("captures console calls into the window buffer, idempotently", () => {
    const calls: string[] = [];
    page.window.console = {
      log: (...a: unknown[]) => calls.push(`log:${a.join(" ")}`),
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    };
    expect(installConsoleHook()).toEqual({ installed: true });
    expect(installConsoleHook()).toEqual({ installed: false, already: true }); // no double wrap

    (page.window.console as Record<string, (...a: unknown[]) => void>).log("hi", { x: 1 });
    expect(calls).toEqual(["log:hi [object Object]"]); // original still invoked, once

    const entries = readConsole().entries as { type: string; text: string }[];
    expect(entries.at(-1)).toMatchObject({ type: "log", text: "hi {\"x\":1}" });
  });

  it("reads an empty buffer before anything is captured", () => {
    page.window.__paiConsole = undefined;
    expect(readConsole()).toEqual({ entries: [] });
  });
});
