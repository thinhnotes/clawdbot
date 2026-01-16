import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { CONFIG_DIR } from "../utils.js";
import type { Pipeline, PipelineStoreFile } from "./types.js";
import type { PipelineServiceState } from "./state.js";

// ============================================================================
// Default Paths
// ============================================================================

export const DEFAULT_PIPELINE_DIR = path.join(CONFIG_DIR, "pipeline");
export const DEFAULT_PIPELINE_STORE_PATH = path.join(
  DEFAULT_PIPELINE_DIR,
  "pipelines.json"
);

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolves the pipeline store path.
 * Handles ~ expansion and defaults to the standard location.
 * @param storePath - Optional custom path
 * @returns Resolved absolute path
 */
export function resolvePipelineStorePath(storePath?: string): string {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) return path.resolve(raw.replace("~", os.homedir()));
    return path.resolve(raw);
  }
  return DEFAULT_PIPELINE_STORE_PATH;
}

// ============================================================================
// Store Version Migration
// ============================================================================

/**
 * Current store version.
 * Increment this when making breaking changes to the store format.
 */
const CURRENT_STORE_VERSION = 1;

/**
 * Migrates a store from an older version to the current version.
 * @param store - The parsed store data
 * @returns Migrated store and whether migration occurred
 */
export function migrateStore(store: Partial<PipelineStoreFile>): {
  store: PipelineStoreFile;
  migrated: boolean;
} {
  let migrated = false;
  const version = typeof store.version === "number" ? store.version : 0;

  // Initialize with defaults
  const result: PipelineStoreFile = {
    version: CURRENT_STORE_VERSION,
    pipelines: [],
    approvalRequests: [],
  };

  // Copy existing data
  if (Array.isArray(store.pipelines)) {
    result.pipelines = store.pipelines.filter(Boolean) as Pipeline[];
  }
  if (Array.isArray(store.approvalRequests)) {
    result.approvalRequests = store.approvalRequests.filter(Boolean);
  }

  // Version-specific migrations
  if (version < 1) {
    // Migration from version 0 (unversioned) to version 1
    // Normalize any legacy data structures here
    migrated = true;

    // Ensure all pipelines have required fields
    for (const pipeline of result.pipelines) {
      // Normalize timestamps - convert from seconds to ms if needed
      if (
        pipeline.createdAtMs &&
        pipeline.createdAtMs < 10_000_000_000 // Before year 2286
      ) {
        pipeline.createdAtMs = pipeline.createdAtMs * 1000;
        migrated = true;
      }
      if (
        pipeline.updatedAtMs &&
        pipeline.updatedAtMs < 10_000_000_000
      ) {
        pipeline.updatedAtMs = pipeline.updatedAtMs * 1000;
        migrated = true;
      }

      // Ensure stages array exists
      if (!Array.isArray(pipeline.stages)) {
        (pipeline as { stages: unknown[] }).stages = [];
        migrated = true;
      }

      // Ensure config exists
      if (!pipeline.config) {
        (pipeline as { config: { stopOnFailure: boolean } }).config = {
          stopOnFailure: true,
        };
        migrated = true;
      }
    }
  }

  // Future migrations: if (version < 2) { ... }

  if (version !== CURRENT_STORE_VERSION) {
    migrated = true;
  }

  return { store: result, migrated };
}

// ============================================================================
// Low-Level Store Operations
// ============================================================================

/**
 * Loads the pipeline store from disk.
 * Uses JSON5 for parsing to allow comments and trailing commas.
 * @param storePath - Path to the store file
 * @returns Parsed and migrated store data
 */
export async function loadPipelineStore(
  storePath: string
): Promise<PipelineStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON5.parse(raw) as Partial<PipelineStoreFile> | null;

    if (!parsed || typeof parsed !== "object") {
      return {
        version: CURRENT_STORE_VERSION,
        pipelines: [],
        approvalRequests: [],
      };
    }

    const { store } = migrateStore(parsed);
    return store;
  } catch (err) {
    // File doesn't exist or is unreadable - return empty store
    // Don't log here as this is expected on first run
    return {
      version: CURRENT_STORE_VERSION,
      pipelines: [],
      approvalRequests: [],
    };
  }
}

/**
 * Saves the pipeline store to disk.
 * Uses atomic write (write to temp file, then rename) for safety.
 * Also creates a backup file for recovery.
 * @param storePath - Path to the store file
 * @param store - Store data to save
 */
export async function savePipelineStore(
  storePath: string,
  store: PipelineStoreFile
): Promise<void> {
  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  // Generate unique temp file name to prevent collisions
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Serialize with pretty formatting
  const json = JSON.stringify(store, null, 2);

  // Write to temp file first
  await fs.promises.writeFile(tmp, json, "utf-8");

  // Atomic rename (this is the key to safe concurrent writes)
  await fs.promises.rename(tmp, storePath);

  // Best-effort backup creation
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // Ignore backup failures - not critical
  }
}

// ============================================================================
// Service-Level Store Operations
// ============================================================================

/**
 * Ensures the store is loaded into state.
 * Loads from disk if not already loaded.
 * Performs any necessary migrations and persists if migrated.
 * @param state - Pipeline service state
 */
export async function ensureLoaded(state: PipelineServiceState): Promise<void> {
  if (state.store) return;

  const loaded = await loadPipelineStore(state.deps.storePath);
  const { store, migrated } = migrateStore(loaded);

  state.store = store;

  // Persist if we migrated the data
  if (migrated) {
    await persist(state);
    state.deps.log.info(
      { path: state.deps.storePath },
      "pipeline: migrated store to current version"
    );
  }
}

/**
 * Persists the current store state to disk.
 * No-op if store hasn't been loaded yet.
 * @param state - Pipeline service state
 */
export async function persist(state: PipelineServiceState): Promise<void> {
  if (!state.store) return;
  await savePipelineStore(state.deps.storePath, state.store);
}

/**
 * Warns if the pipeline service is disabled.
 * Only warns once per service instance to avoid log spam.
 * @param state - Pipeline service state
 * @param action - The action that triggered the warning
 */
export function warnIfDisabled(state: PipelineServiceState, action: string): void {
  if (state.deps.pipelineEnabled) return;
  if (state.warnedDisabled) return;
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "pipeline: service disabled; pipelines will not run automatically"
  );
}

// ============================================================================
// Store Utilities
// ============================================================================

/**
 * Checks if a store file exists at the given path.
 * @param storePath - Path to check
 * @returns True if the file exists
 */
export async function storeExists(storePath: string): Promise<boolean> {
  try {
    await fs.promises.access(storePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes the store file and its backup.
 * Use with caution - this is destructive.
 * @param storePath - Path to the store file
 */
export async function deleteStore(storePath: string): Promise<void> {
  try {
    await fs.promises.unlink(storePath);
  } catch {
    // Ignore if file doesn't exist
  }
  try {
    await fs.promises.unlink(`${storePath}.bak`);
  } catch {
    // Ignore if backup doesn't exist
  }
}

/**
 * Restores the store from backup.
 * @param storePath - Path to the store file
 * @returns True if restore was successful
 */
export async function restoreFromBackup(storePath: string): Promise<boolean> {
  const backupPath = `${storePath}.bak`;
  try {
    await fs.promises.access(backupPath, fs.constants.F_OK);
    await fs.promises.copyFile(backupPath, storePath);
    return true;
  } catch {
    return false;
  }
}
