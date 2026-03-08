/**
 * Shared mutable daemon state — module-level singletons used across all daemon sub-modules.
 */

import { openRegistry } from "../../registry/db.js";
import type { StorageBackend } from "../../storage/interface.js";
import type { NotificationConfig } from "../../notifications/types.js";
import type { PaiDaemonConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Core singletons (assigned at startup by serve())
// ---------------------------------------------------------------------------

export let registryDb: ReturnType<typeof openRegistry>;
export let storageBackend: StorageBackend;
export let daemonConfig: PaiDaemonConfig;
export let startTime = Date.now();

// ---------------------------------------------------------------------------
// Scheduler state
// ---------------------------------------------------------------------------

/** True while a project index pass is running. */
export let indexInProgress = false;
export let lastIndexTime = 0;
export let indexSchedulerTimer: ReturnType<typeof setInterval> | null = null;

/** True while an embedding pass is running. */
export let embedInProgress = false;
export let lastEmbedTime = 0;
export let embedSchedulerTimer: ReturnType<typeof setInterval> | null = null;

/** True while a vault index pass is running. */
export let vaultIndexInProgress = false;
export let lastVaultIndexTime = 0;

// ---------------------------------------------------------------------------
// Notification state
// ---------------------------------------------------------------------------

/** Mutable notification config — loaded from disk at startup, patchable at runtime. */
export let notificationConfig: NotificationConfig;

// ---------------------------------------------------------------------------
// Graceful shutdown flag
// ---------------------------------------------------------------------------

/**
 * Set to true when a SIGTERM/SIGINT is received so that long-running loops
 * (embed, index) can detect the signal and exit their inner loops before the
 * pool/backend is closed.
 */
export let shutdownRequested = false;

// ---------------------------------------------------------------------------
// Setters (TypeScript requires assignment functions for exported `let` vars
// that need to be mutated across module boundaries)
// ---------------------------------------------------------------------------

export function setRegistryDb(db: ReturnType<typeof openRegistry>): void { registryDb = db; }
export function setStorageBackend(b: StorageBackend): void { storageBackend = b; }
export function setDaemonConfig(c: PaiDaemonConfig): void { daemonConfig = c; }
export function setStartTime(t: number): void { startTime = t; }
export function setNotificationConfig(c: NotificationConfig): void { notificationConfig = c; }
export function setShutdownRequested(v: boolean): void { shutdownRequested = v; }
export function setIndexInProgress(v: boolean): void { indexInProgress = v; }
export function setLastIndexTime(v: number): void { lastIndexTime = v; }
export function setIndexSchedulerTimer(v: ReturnType<typeof setInterval> | null): void { indexSchedulerTimer = v; }
export function setEmbedInProgress(v: boolean): void { embedInProgress = v; }
export function setLastEmbedTime(v: number): void { lastEmbedTime = v; }
export function setEmbedSchedulerTimer(v: ReturnType<typeof setInterval> | null): void { embedSchedulerTimer = v; }
export function setVaultIndexInProgress(v: boolean): void { vaultIndexInProgress = v; }
export function setLastVaultIndexTime(v: number): void { lastVaultIndexTime = v; }
