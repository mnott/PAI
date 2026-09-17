#!/usr/bin/env node
/**
 * Installs (or removes) the NativeMessagingHosts manifest for the PAI browser
 * bridge host.
 *
 *   node src/browser-bridge/host/install.mjs --extension-id <32 chars>
 *
 * Writes com.pai.browser_bridge.json pointing at the host.mjs next to this
 * script, with allowed_origins locked to the one extension id. macOS Chrome's
 * user-level directory is the default destination; --dest overrides it (for
 * tests), --chrome-dir points at a non-default Chrome profile root.
 * --uninstall removes the manifest again.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.pai.browser_bridge";
const MANIFEST_NAME = `${HOST_NAME}.json`;

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
const has = (flag) => args.includes(flag);

const hostPath = fileURLToPath(new URL("./host.mjs", import.meta.url));
const scriptDir = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`install: ${message}\n`);
  process.exit(1);
}

// --- argument validation ------------------------------------------------------

let extensionId = argValue("--extension-id");
if (extensionId !== undefined && !/^[a-zA-Z0-9]{32}$/.test(extensionId)) {
  fail(`--extension-id must be exactly 32 alphanumeric characters (got ${String(extensionId).length})`);
}

// --- destination --------------------------------------------------------------

let destDir;
if (has("--dest")) {
  destDir = argValue("--dest");
  if (!destDir || !isAbsolute(destDir)) fail("--dest needs an absolute directory path");
} else {
  const chromeDir =
    argValue("--chrome-dir") ??
    join(homedir(), "Library", "Application Support", "Google", "Chrome");
  // Chrome looks for user-level (non-packaged-app) hosts in NativeMessagingHosts.
  destDir = join(chromeDir, "NativeMessagingHosts");
}

// --user-level is the only install mode this script supports; accepted for
// explicitness and forwards compatibility.
if (has("--user-level") && !has("--dest") && !has("--chrome-dir")) {
  // destDir already is the user-scoped Chrome directory on macOS
}

const manifestPath = join(destDir, MANIFEST_NAME);

// --- uninstall ----------------------------------------------------------------

if (has("--uninstall")) {
  if (existsSync(manifestPath)) {
    rmSync(manifestPath);
    process.stdout.write(`removed ${manifestPath}\n`);
  } else {
    process.stdout.write(`nothing to remove at ${manifestPath}\n`);
  }
  process.exit(0);
}

// --- install ------------------------------------------------------------------

if (!extensionId) {
  fail(
    "--extension-id is required: load the unpacked extension in Chrome " +
      "(chrome://extensions → Developer mode → Load unpacked), copy its ID, and pass it here"
  );
}

if (!existsSync(hostPath)) fail(`host script not found next to this installer: ${hostPath}`);

// The manifest runs host.mjs directly; the shebang line invokes node.
chmodSync(hostPath, 0o755);

const manifest = {
  name: HOST_NAME,
  description: "PAI browser bridge — connects Chrome to the PAI browser MCP server",
  path: resolve(hostPath),
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

mkdirSync(destDir, { recursive: true });
const existing = existsSync(manifestPath)
  ? (() => {
      try {
        return JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        return null;
      }
    })()
  : null;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });

const changed = JSON.stringify(existing) !== JSON.stringify(manifest);
process.stdout.write(
  `${changed ? "wrote" : "unchanged"} ${manifestPath}\n` +
    `  host: ${manifest.path}\n` +
    `  allowed_origins: ${manifest.allowed_origins[0]}\n` +
    `  restart Chrome for the change to take effect\n`
);
