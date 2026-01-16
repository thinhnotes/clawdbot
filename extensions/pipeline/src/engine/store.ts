/**
 * Pipeline Store
 *
 * Persistent storage for pipeline runs and history with configurable
 * retention policies. Supports both in-memory and file-based storage.
 *
 * Features:
 * - In-memory store for fast access with optional file persistence
 * - CRUD operations for pipeline runs
 * - Query by status, time range, pipeline name
 * - Configurable history retention (by count and age)
 * - Automatic cleanup of old runs
 *
 * @example
 * ```typescript
 * import { PipelineStore, createStore } from "./store.js";
 *
 * // Create with file persistence
 * const store = createStore({
 *   type: "file",
 *   filePath: "./data/pipelines.json",
 *   maxHistorySize: 100,
 *   maxHistoryAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
 * });
 *
 * // Initialize store (loads from file if exists)
 * await store.initialize();
 *
 * // Save a pipeline run
 * await store.saveRun(pipelineRun);
 *
 * // Query runs
 * const recentRuns = await store.queryRuns({ state: "succeeded", limit: 10 });
 *
 * // Cleanup old runs
 * await store.cleanup();
 *
 * // Persist to file
 * await store.flush();
 * ```
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  PipelineRun,
  PipelineRunId,
  PipelineState,
} from "../types.js";
import { PipelineRunSchema, TerminalPipelineStates } from "../types.js";
import type { PipelineStoreConfig } from "../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Query options for filtering pipeline runs
 */
export interface QueryRunsOptions {
  /** Filter by pipeline ID */
  pipelineId?: string;
  /** Filter by pipeline name (partial match supported) */
  pipelineName?: string;
  /** Filter by state */
  state?: PipelineState;
  /** Filter by multiple states */
  states?: PipelineState[];
  /** Filter runs after this timestamp (queuedAt) */
  after?: number;
  /** Filter runs before this timestamp (queuedAt) */
  before?: number;
  /** Filter by trigger source/user */
  triggeredBy?: string;
  /** Filter by source branch */
  sourceBranch?: string;
  /** Filter by provider */
  provider?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
  /** Sort order for results (default: descending by queuedAt) */
  orderBy?: "queuedAt" | "finishedAt" | "pipelineName";
  /** Sort direction */
  orderDirection?: "asc" | "desc";
  /** Only include terminal (completed) runs */
  terminalOnly?: boolean;
  /** Only include active (non-terminal) runs */
  activeOnly?: boolean;
}

/**
 * Result of a query operation
 */
export interface QueryRunsResult {
  /** Matching runs */
  runs: PipelineRun[];
  /** Total count of matching runs (before limit/offset) */
  totalCount: number;
  /** Whether more results are available */
  hasMore: boolean;
}

/**
 * Statistics about the store
 */
export interface StoreStats {
  /** Total number of stored runs */
  totalRuns: number;
  /** Runs by state */
  runsByState: Record<PipelineState, number>;
  /** Active (non-terminal) runs */
  activeRuns: number;
  /** Oldest run timestamp */
  oldestRunAt?: number;
  /** Newest run timestamp */
  newestRunAt?: number;
  /** Storage type */
  storageType: "memory" | "file";
  /** Last persist timestamp (for file storage) */
  lastPersistedAt?: number;
  /** Dirty (unsaved changes) */
  isDirty: boolean;
}

/**
 * Storage data format for file persistence
 */
interface StorageData {
  version: number;
  runs: PipelineRun[];
  lastUpdated: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const STORAGE_VERSION = 1;
const DEFAULT_MAX_HISTORY_SIZE = 100;
const DEFAULT_MAX_HISTORY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by PipelineStore operations
 */
export class PipelineStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_EXISTS"
      | "PERSISTENCE_FAILED"
      | "LOAD_FAILED"
      | "VALIDATION_FAILED"
      | "NOT_INITIALIZED"
  ) {
    super(message);
    this.name = "PipelineStoreError";
  }
}

// -----------------------------------------------------------------------------
// PipelineStore Implementation
// -----------------------------------------------------------------------------

/**
 * Pipeline store for managing pipeline run persistence.
 *
 * Provides:
 * - In-memory storage with optional file persistence
 * - CRUD operations for pipeline runs
 * - Query by status, time range, pipeline name
 * - Configurable history retention
 */
export class PipelineStore {
  private readonly runs: Map<PipelineRunId, PipelineRun> = new Map();
  private readonly config: Required<PipelineStoreConfig>;
  private initialized = false;
  private dirty = false;
  private lastPersistedAt?: number;
  private persistTimer?: NodeJS.Timeout;
  private readonly persistDebounceMs = 1000;

  constructor(config?: Partial<PipelineStoreConfig>) {
    // Apply defaults
    this.config = {
      type: config?.type ?? "memory",
      filePath: config?.filePath,
      maxHistorySize: config?.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE,
      maxHistoryAgeMs: config?.maxHistoryAgeMs ?? DEFAULT_MAX_HISTORY_AGE_MS,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the store. For file storage, loads existing data from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.config.type === "file" && this.config.filePath) {
      await this.loadFromFile();
    }

    this.initialized = true;
  }

  /**
   * Check if the store is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose the store, flushing any pending changes
   */
  async dispose(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    if (this.dirty && this.config.type === "file") {
      await this.flush();
    }

    this.runs.clear();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a pipeline run to the store.
   * Creates new or updates existing run.
   *
   * @param run - Pipeline run to save
   * @returns Saved pipeline run
   */
  async saveRun(run: PipelineRun): Promise<PipelineRun> {
    this.ensureInitialized();

    // Validate run
    const parseResult = PipelineRunSchema.safeParse(run);
    if (!parseResult.success) {
      throw new PipelineStoreError(
        `Invalid pipeline run: ${parseResult.error.message}`,
        "VALIDATION_FAILED"
      );
    }

    const validRun = parseResult.data;
    this.runs.set(validRun.id, validRun);
    this.markDirty();

    return validRun;
  }

  /**
   * Get a pipeline run by ID
   *
   * @param runId - Pipeline run ID
   * @returns Pipeline run or undefined if not found
   */
  async getRun(runId: PipelineRunId): Promise<PipelineRun | undefined> {
    this.ensureInitialized();
    return this.runs.get(runId);
  }

  /**
   * Get a pipeline run by ID, throwing if not found
   *
   * @param runId - Pipeline run ID
   * @returns Pipeline run
   * @throws PipelineStoreError if not found
   */
  async getRunOrThrow(runId: PipelineRunId): Promise<PipelineRun> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new PipelineStoreError(
        `Pipeline run not found: ${runId}`,
        "NOT_FOUND"
      );
    }
    return run;
  }

  /**
   * Get a pipeline run by provider run ID
   *
   * @param providerRunId - Provider-specific run ID
   * @returns Pipeline run or undefined if not found
   */
  async getRunByProviderRunId(providerRunId: string): Promise<PipelineRun | undefined> {
    this.ensureInitialized();
    for (const run of this.runs.values()) {
      if (run.providerRunId === providerRunId) {
        return run;
      }
    }
    return undefined;
  }

  /**
   * Update a pipeline run
   *
   * @param runId - Pipeline run ID
   * @param updates - Partial updates to apply
   * @returns Updated pipeline run
   * @throws PipelineStoreError if not found
   */
  async updateRun(
    runId: PipelineRunId,
    updates: Partial<Omit<PipelineRun, "id" | "provider">>
  ): Promise<PipelineRun> {
    const run = await this.getRunOrThrow(runId);

    // Apply updates
    const updatedRun: PipelineRun = {
      ...run,
      ...updates,
      id: run.id, // Ensure immutable fields
      provider: run.provider,
    };

    // Validate updated run
    const parseResult = PipelineRunSchema.safeParse(updatedRun);
    if (!parseResult.success) {
      throw new PipelineStoreError(
        `Invalid pipeline run after update: ${parseResult.error.message}`,
        "VALIDATION_FAILED"
      );
    }

    const validRun = parseResult.data;
    this.runs.set(runId, validRun);
    this.markDirty();

    return validRun;
  }

  /**
   * Delete a pipeline run
   *
   * @param runId - Pipeline run ID
   * @returns True if run was deleted, false if not found
   */
  async deleteRun(runId: PipelineRunId): Promise<boolean> {
    this.ensureInitialized();
    const deleted = this.runs.delete(runId);
    if (deleted) {
      this.markDirty();
    }
    return deleted;
  }

  /**
   * Check if a run exists
   *
   * @param runId - Pipeline run ID
   * @returns True if run exists
   */
  async hasRun(runId: PipelineRunId): Promise<boolean> {
    this.ensureInitialized();
    return this.runs.has(runId);
  }

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  /**
   * Query pipeline runs with filtering, sorting, and pagination
   *
   * @param options - Query options
   * @returns Query result with matching runs
   */
  async queryRuns(options: QueryRunsOptions = {}): Promise<QueryRunsResult> {
    this.ensureInitialized();

    let runs = Array.from(this.runs.values());

    // Apply filters
    runs = this.applyFilters(runs, options);

    // Get total count before pagination
    const totalCount = runs.length;

    // Apply sorting
    runs = this.applySorting(runs, options);

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;

    if (offset > 0) {
      runs = runs.slice(offset);
    }

    const hasMore = limit !== undefined && runs.length > limit;

    if (limit !== undefined) {
      runs = runs.slice(0, limit);
    }

    return {
      runs,
      totalCount,
      hasMore,
    };
  }

  /**
   * Get all pipeline runs (unfiltered)
   */
  async getAllRuns(): Promise<PipelineRun[]> {
    this.ensureInitialized();
    return Array.from(this.runs.values());
  }

  /**
   * Get active (non-terminal) runs
   */
  async getActiveRuns(): Promise<PipelineRun[]> {
    const result = await this.queryRuns({ activeOnly: true });
    return result.runs;
  }

  /**
   * Get the most recent runs
   *
   * @param limit - Maximum number of runs to return
   * @param pipelineId - Optional pipeline ID filter
   */
  async getRecentRuns(limit: number, pipelineId?: string): Promise<PipelineRun[]> {
    const result = await this.queryRuns({
      pipelineId,
      limit,
      orderBy: "queuedAt",
      orderDirection: "desc",
    });
    return result.runs;
  }

  /**
   * Get runs that have pending approvals
   */
  async getRunsWaitingForApproval(): Promise<PipelineRun[]> {
    const result = await this.queryRuns({ state: "waiting_for_approval" });
    return result.runs;
  }

  /**
   * Count runs matching criteria
   */
  async countRuns(options: QueryRunsOptions = {}): Promise<number> {
    const result = await this.queryRuns({ ...options, limit: undefined });
    return result.totalCount;
  }

  // ---------------------------------------------------------------------------
  // History Management
  // ---------------------------------------------------------------------------

  /**
   * Cleanup old runs based on retention configuration.
   * Removes runs that exceed the max history size or age.
   * Only terminal runs are eligible for cleanup.
   *
   * @returns Number of runs removed
   */
  async cleanup(): Promise<number> {
    this.ensureInitialized();

    const now = Date.now();
    let removedCount = 0;

    // Get all terminal runs sorted by queuedAt (oldest first)
    const terminalRuns = Array.from(this.runs.values())
      .filter((run) => TerminalPipelineStates.has(run.state))
      .sort((a, b) => a.queuedAt - b.queuedAt);

    // Remove runs exceeding max age
    if (this.config.maxHistoryAgeMs > 0) {
      const cutoffTime = now - this.config.maxHistoryAgeMs;
      for (const run of terminalRuns) {
        if (run.queuedAt < cutoffTime) {
          this.runs.delete(run.id);
          removedCount++;
        }
      }
    }

    // Refresh terminal runs list after age-based cleanup
    const remainingTerminalRuns = Array.from(this.runs.values())
      .filter((run) => TerminalPipelineStates.has(run.state))
      .sort((a, b) => a.queuedAt - b.queuedAt);

    // Remove oldest runs exceeding max count
    if (this.config.maxHistorySize > 0) {
      const excessCount = remainingTerminalRuns.length - this.config.maxHistorySize;
      if (excessCount > 0) {
        for (let i = 0; i < excessCount; i++) {
          const run = remainingTerminalRuns[i];
          if (run) {
            this.runs.delete(run.id);
            removedCount++;
          }
        }
      }
    }

    if (removedCount > 0) {
      this.markDirty();
    }

    return removedCount;
  }

  /**
   * Get store statistics
   */
  async getStats(): Promise<StoreStats> {
    this.ensureInitialized();

    const runs = Array.from(this.runs.values());
    const runsByState: Record<PipelineState, number> = {
      queued: 0,
      running: 0,
      waiting_for_approval: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    };

    let activeRuns = 0;
    let oldestRunAt: number | undefined;
    let newestRunAt: number | undefined;

    for (const run of runs) {
      runsByState[run.state] = (runsByState[run.state] || 0) + 1;

      if (!TerminalPipelineStates.has(run.state)) {
        activeRuns++;
      }

      if (oldestRunAt === undefined || run.queuedAt < oldestRunAt) {
        oldestRunAt = run.queuedAt;
      }
      if (newestRunAt === undefined || run.queuedAt > newestRunAt) {
        newestRunAt = run.queuedAt;
      }
    }

    return {
      totalRuns: runs.length,
      runsByState,
      activeRuns,
      oldestRunAt,
      newestRunAt,
      storageType: this.config.type,
      lastPersistedAt: this.lastPersistedAt,
      isDirty: this.dirty,
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence Operations
  // ---------------------------------------------------------------------------

  /**
   * Flush pending changes to disk (for file storage).
   * No-op for memory storage.
   */
  async flush(): Promise<void> {
    if (this.config.type !== "file" || !this.config.filePath) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    await this.saveToFile();
    this.dirty = false;
  }

  /**
   * Force reload from disk (for file storage).
   * Discards any unsaved changes.
   */
  async reload(): Promise<void> {
    if (this.config.type !== "file" || !this.config.filePath) {
      return;
    }

    this.runs.clear();
    await this.loadFromFile();
    this.dirty = false;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new PipelineStoreError(
        "Store not initialized. Call initialize() first.",
        "NOT_INITIALIZED"
      );
    }
  }

  private markDirty(): void {
    this.dirty = true;

    // Debounce file persistence
    if (this.config.type === "file" && this.config.filePath) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
      }
      this.persistTimer = setTimeout(() => {
        this.flush().catch(() => {
          // Ignore background persistence errors
        });
      }, this.persistDebounceMs);
    }
  }

  private applyFilters(runs: PipelineRun[], options: QueryRunsOptions): PipelineRun[] {
    return runs.filter((run) => {
      // Pipeline ID filter
      if (options.pipelineId && run.pipelineId !== options.pipelineId) {
        return false;
      }

      // Pipeline name filter (partial match, case-insensitive)
      if (options.pipelineName) {
        const searchTerm = options.pipelineName.toLowerCase();
        if (!run.pipelineName.toLowerCase().includes(searchTerm)) {
          return false;
        }
      }

      // State filter
      if (options.state && run.state !== options.state) {
        return false;
      }

      // Multiple states filter
      if (options.states && !options.states.includes(run.state)) {
        return false;
      }

      // Time range filters
      if (options.after && run.queuedAt < options.after) {
        return false;
      }
      if (options.before && run.queuedAt > options.before) {
        return false;
      }

      // Triggered by filter
      if (options.triggeredBy && run.triggeredBy !== options.triggeredBy) {
        return false;
      }

      // Source branch filter
      if (options.sourceBranch && run.sourceBranch !== options.sourceBranch) {
        return false;
      }

      // Provider filter
      if (options.provider && run.provider !== options.provider) {
        return false;
      }

      // Terminal only filter
      if (options.terminalOnly && !TerminalPipelineStates.has(run.state)) {
        return false;
      }

      // Active only filter
      if (options.activeOnly && TerminalPipelineStates.has(run.state)) {
        return false;
      }

      return true;
    });
  }

  private applySorting(runs: PipelineRun[], options: QueryRunsOptions): PipelineRun[] {
    const orderBy = options.orderBy ?? "queuedAt";
    const orderDirection = options.orderDirection ?? "desc";
    const multiplier = orderDirection === "asc" ? 1 : -1;

    return runs.sort((a, b) => {
      let aValue: number | string;
      let bValue: number | string;

      switch (orderBy) {
        case "queuedAt":
          aValue = a.queuedAt;
          bValue = b.queuedAt;
          break;
        case "finishedAt":
          aValue = a.finishedAt ?? 0;
          bValue = b.finishedAt ?? 0;
          break;
        case "pipelineName":
          aValue = a.pipelineName.toLowerCase();
          bValue = b.pipelineName.toLowerCase();
          break;
        default:
          aValue = a.queuedAt;
          bValue = b.queuedAt;
      }

      if (aValue < bValue) return -1 * multiplier;
      if (aValue > bValue) return 1 * multiplier;
      return 0;
    });
  }

  private async loadFromFile(): Promise<void> {
    if (!this.config.filePath) {
      return;
    }

    try {
      const content = await readFile(this.config.filePath, "utf-8");
      const data: StorageData = JSON.parse(content);

      // Validate version
      if (data.version !== STORAGE_VERSION) {
        // For now, we only support version 1
        // Future versions may need migration logic
        throw new PipelineStoreError(
          `Unsupported storage version: ${data.version}`,
          "LOAD_FAILED"
        );
      }

      // Validate and load runs
      for (const run of data.runs) {
        const parseResult = PipelineRunSchema.safeParse(run);
        if (parseResult.success) {
          this.runs.set(parseResult.data.id, parseResult.data);
        }
        // Skip invalid runs silently to allow partial recovery
      }

      this.lastPersistedAt = data.lastUpdated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet, start with empty store
        return;
      }
      if (error instanceof PipelineStoreError) {
        throw error;
      }
      throw new PipelineStoreError(
        `Failed to load pipeline store: ${error instanceof Error ? error.message : String(error)}`,
        "LOAD_FAILED"
      );
    }
  }

  private async saveToFile(): Promise<void> {
    if (!this.config.filePath) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = dirname(this.config.filePath);
      await mkdir(dir, { recursive: true });

      const data: StorageData = {
        version: STORAGE_VERSION,
        runs: Array.from(this.runs.values()),
        lastUpdated: Date.now(),
      };

      const content = JSON.stringify(data, null, 2);
      await writeFile(this.config.filePath, content, "utf-8");

      this.lastPersistedAt = data.lastUpdated;
    } catch (error) {
      throw new PipelineStoreError(
        `Failed to save pipeline store: ${error instanceof Error ? error.message : String(error)}`,
        "PERSISTENCE_FAILED"
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Create a new pipeline store instance
 *
 * @param config - Store configuration
 * @returns Uninitialized store instance (call initialize() before use)
 */
export function createStore(config?: Partial<PipelineStoreConfig>): PipelineStore {
  return new PipelineStore(config);
}

/**
 * Create and initialize a pipeline store
 *
 * @param config - Store configuration
 * @returns Initialized store instance
 */
export async function createAndInitializeStore(
  config?: Partial<PipelineStoreConfig>
): Promise<PipelineStore> {
  const store = createStore(config);
  await store.initialize();
  return store;
}
