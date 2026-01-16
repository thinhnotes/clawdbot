/**
 * Pipeline Manager
 *
 * Central manager class that coordinates all pipeline components:
 * - Pipeline providers (Azure DevOps, GitHub Actions, GitLab CI, Mock)
 * - State machine for execution tracking
 * - Approval queue and handler for approval workflows
 * - Notification hub for multi-channel alerts
 * - Pipeline store for persistence
 *
 * Features:
 * - Trigger pipelines with provider routing
 * - Monitor pipeline status with polling support
 * - Handle approval decisions
 * - Fetch build logs
 * - Query pipeline history
 * - Event-driven notifications
 *
 * @example
 * ```typescript
 * import { PipelineManager, createPipelineManager } from "./manager.js";
 *
 * // Create manager with dependencies
 * const manager = createPipelineManager({
 *   provider,
 *   stateMachine,
 *   store,
 *   approvalQueue,
 *   approvalHandler,
 *   notificationHub,
 * });
 *
 * // Initialize manager
 * await manager.initialize();
 *
 * // Trigger a pipeline
 * const run = await manager.triggerPipeline({
 *   pipelineId: "build-and-deploy",
 *   branch: "main",
 * });
 *
 * // Handle an approval
 * await manager.handleApproval({
 *   approvalId: "approval-123",
 *   decision: "approve",
 *   comment: "LGTM",
 * });
 *
 * // Get pipeline logs
 * const logs = await manager.getLogs({ runId: run.id });
 * ```
 */

import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  GetLogsInput,
  GetLogsResult,
  PipelineDefinition,
  PipelineEventMap,
  PipelineRun,
  PipelineRunId,
  PipelineState,
  ProviderName,
  Stage,
  StageId,
  TriggerPipelineInput,
} from "./types.js";
import { TerminalPipelineStates } from "./types.js";
import type { PipelineProvider } from "./providers/base.js";
import type { PipelineStateMachine, CreateRunInput } from "./engine/state-machine.js";
import type { PipelineStore, QueryRunsOptions } from "./engine/store.js";
import type { ApprovalQueue } from "./engine/approval.js";
import type {
  ApprovalHandler,
  HandleApprovalInput,
  HandleApprovalResult,
} from "./engine/approval-handler.js";
import type { NotificationHub } from "./notifications/hub.js";
import type { PipelinePollingConfig } from "./config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Input for triggering a pipeline
 */
export interface TriggerInput {
  /** Pipeline ID to trigger */
  pipelineId: string;
  /** Branch to build (optional, uses default if not specified) */
  branch?: string;
  /** Pipeline parameters */
  parameters?: Record<string, string>;
  /** Optional commit/ref to build */
  commitId?: string;
  /** Who triggered the pipeline */
  triggeredBy?: string;
}

/**
 * Result of triggering a pipeline
 */
export interface TriggerResult {
  /** Internal run ID */
  runId: PipelineRunId;
  /** Provider-specific run ID */
  providerRunId: string;
  /** URL to view the run in provider UI */
  webUrl?: string;
  /** Initial pipeline run state */
  run: PipelineRun;
}

/**
 * Input for getting pipeline status
 */
export interface GetStatusInput {
  /** Pipeline run ID (internal or provider) */
  runId: string;
  /** Whether to refresh status from provider */
  refresh?: boolean;
}

/**
 * Input for getting pipeline history
 */
export interface GetHistoryInput {
  /** Filter by pipeline ID */
  pipelineId?: string;
  /** Filter by pipeline name (partial match) */
  pipelineName?: string;
  /** Filter by state */
  state?: PipelineState;
  /** Maximum number of results */
  limit?: number;
  /** Filter runs after this timestamp */
  after?: number;
  /** Filter runs before this timestamp */
  before?: number;
}

/**
 * Result of querying pipeline history
 */
export interface GetHistoryResult {
  /** Matching pipeline runs */
  runs: PipelineRun[];
  /** Total count (before pagination) */
  totalCount: number;
  /** Whether more results are available */
  hasMore: boolean;
}

/**
 * Input for approval handling
 */
export interface ApprovalInput {
  /** Approval ID to process */
  approvalId: ApprovalId;
  /** Decision: "approve" or "reject" */
  decision: ApprovalDecision;
  /** Optional comment */
  comment?: string;
  /** User making the decision */
  approvedBy?: string;
}

/**
 * Manager event types (extends base pipeline events)
 */
export type PipelineManagerEventMap = PipelineEventMap & {
  /** Emitted when a pipeline is triggered */
  "manager.pipeline_triggered": TriggerResult;
  /** Emitted when polling starts for a run */
  "manager.polling_started": { runId: PipelineRunId };
  /** Emitted when polling stops for a run */
  "manager.polling_stopped": { runId: PipelineRunId; reason: "completed" | "timeout" | "cancelled" };
  /** Emitted when status is refreshed from provider */
  "manager.status_refreshed": PipelineRun;
  /** Emitted on manager error */
  "manager.error": { error: Error; context: string; runId?: PipelineRunId };
};

export type PipelineManagerEventHandler<K extends keyof PipelineManagerEventMap> = (
  event: PipelineManagerEventMap[K]
) => void | Promise<void>;

/**
 * Dependencies required by the pipeline manager
 */
export interface PipelineManagerDependencies {
  /** Pipeline provider for API calls */
  provider: PipelineProvider;
  /** State machine for tracking execution state */
  stateMachine: PipelineStateMachine;
  /** Store for persistence (optional) */
  store?: PipelineStore;
  /** Approval queue for pending approvals */
  approvalQueue: ApprovalQueue;
  /** Approval handler for processing decisions */
  approvalHandler: ApprovalHandler;
  /** Notification hub for alerts (optional) */
  notificationHub?: NotificationHub;
}

/**
 * Configuration for the pipeline manager
 */
export interface PipelineManagerConfig {
  /** Polling configuration */
  polling?: PipelinePollingConfig;
  /** Default pipeline ID to use if not specified */
  defaultPipeline?: string;
  /** Default branch to use if not specified */
  defaultBranch?: string;
  /** Auto-start polling when pipeline is triggered */
  autoStartPolling?: boolean;
  /** Request timeout for provider calls */
  requestTimeoutMs?: number;
}

/**
 * Statistics about the pipeline manager
 */
export interface PipelineManagerStats {
  /** Number of active (polling) runs */
  activeRuns: number;
  /** Total runs tracked in state machine */
  totalRunsTracked: number;
  /** Total runs in store */
  totalRunsStored?: number;
  /** Pending approvals count */
  pendingApprovals: number;
  /** Provider name */
  provider: ProviderName;
  /** Whether manager is initialized */
  initialized: boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_POLLING_INTERVAL_MS = 15000;
const DEFAULT_FAST_POLLING_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLLING_DURATION_MS = 7200000; // 2 hours
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by PipelineManager operations
 */
export class PipelineManagerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_INITIALIZED"
      | "NOT_FOUND"
      | "PROVIDER_ERROR"
      | "STATE_ERROR"
      | "APPROVAL_ERROR"
      | "POLLING_ERROR"
      | "VALIDATION_ERROR"
      | "TIMEOUT"
  ) {
    super(message);
    this.name = "PipelineManagerError";
  }
}

// -----------------------------------------------------------------------------
// PipelineManager Implementation
// -----------------------------------------------------------------------------

/**
 * Central manager for pipeline operations.
 *
 * Coordinates:
 * - Provider interactions for triggering and monitoring
 * - State machine for execution tracking
 * - Approval workflow processing
 * - Notification dispatching
 * - Status polling
 */
export class PipelineManager {
  private readonly deps: PipelineManagerDependencies;
  private readonly config: Required<PipelineManagerConfig>;
  private readonly eventHandlers: Map<
    keyof PipelineManagerEventMap,
    Set<PipelineManagerEventHandler<keyof PipelineManagerEventMap>>
  > = new Map();
  private readonly pollingRuns: Map<PipelineRunId, { abortController: AbortController; startedAt: number }> = new Map();
  private initialized = false;

  constructor(deps: PipelineManagerDependencies, config?: PipelineManagerConfig) {
    this.deps = deps;
    this.config = {
      polling: config?.polling ?? {
        enabled: true,
        intervalMs: DEFAULT_POLLING_INTERVAL_MS,
        fastIntervalMs: DEFAULT_FAST_POLLING_INTERVAL_MS,
        maxDurationMs: DEFAULT_MAX_POLLING_DURATION_MS,
      },
      defaultPipeline: config?.defaultPipeline ?? "",
      defaultBranch: config?.defaultBranch ?? "",
      autoStartPolling: config?.autoStartPolling ?? true,
      requestTimeoutMs: config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the pipeline manager and wire up component events
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Wire up state machine events to notification hub
    this.setupStateMachineEventHandlers();

    // Wire up approval queue to notification hub
    this.setupApprovalQueueEventHandlers();

    this.initialized = true;
  }

  /**
   * Check if the manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose the manager and clean up resources
   */
  async dispose(): Promise<void> {
    // Stop all active polling
    for (const [runId] of this.pollingRuns) {
      this.stopPolling(runId);
    }

    this.eventHandlers.clear();
    this.initialized = false;
  }

  private setupStateMachineEventHandlers(): void {
    const { stateMachine, notificationHub } = this.deps;

    // Forward pipeline events to notification hub
    stateMachine.on("pipeline.started", async (run) => {
      if (notificationHub) {
        await notificationHub.notifyPipelineStarted(run);
      }
      // Forward to manager event handlers
      await this.emit("pipeline.started", run);
    });

    stateMachine.on("pipeline.completed", async (run) => {
      if (notificationHub) {
        await notificationHub.notifyPipelineCompleted(run);
      }
      // Forward to manager event handlers
      await this.emit("pipeline.completed", run);
    });

    stateMachine.on("stage.started", async ({ run, stage }) => {
      if (notificationHub) {
        await notificationHub.notifyStageStarted(run, stage);
      }
      // Forward to manager event handlers
      await this.emit("stage.started", { run, stage });
    });

    stateMachine.on("stage.completed", async ({ run, stage }) => {
      if (notificationHub) {
        await notificationHub.notifyStageCompleted(run, stage);
      }
      // Forward to manager event handlers
      await this.emit("stage.completed", { run, stage });
    });

    stateMachine.on("stage.waiting_for_approval", async ({ run, stage, approval }) => {
      // Add approval to queue
      await this.deps.approvalQueue.addApproval({
        runId: run.id,
        providerRunId: run.providerRunId,
        stageId: stage.id,
        stageName: stage.name,
        pipelineName: run.pipelineName,
        providerApprovalId: approval.providerApprovalId,
        approvers: approval.approvers,
        instructions: approval.instructions,
      });

      // Forward to manager event handlers
      await this.emit("stage.waiting_for_approval", { run, stage, approval });
    });
  }

  private setupApprovalQueueEventHandlers(): void {
    // Approval events are already handled by the ApprovalQueue's
    // integration with the notification hub, so we just forward events
    const { approvalQueue } = this.deps;

    approvalQueue.on("approval.timeout", async (approval) => {
      // When approval times out, we may need to update the state machine
      const run = this.deps.stateMachine.getRun(approval.runId);
      if (run) {
        // Try to transition stage to failed state
        const stage = run.stages.find((s) => s.id === approval.stageId);
        if (stage && stage.state === "waiting_for_approval") {
          try {
            await this.deps.stateMachine.transitionStage(
              approval.runId,
              approval.stageId,
              "rejected",
              { result: "failed", error: "Approval timed out" }
            );
            await this.deps.stateMachine.skipRemainingStages(approval.runId, approval.stageId);
            await this.deps.stateMachine.transitionPipeline(approval.runId, "failed");
          } catch {
            // Ignore state transition errors on timeout
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to manager events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof PipelineManagerEventMap>(
    event: K,
    handler: PipelineManagerEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as PipelineManagerEventHandler<keyof PipelineManagerEventMap>);

    return () => {
      handlers?.delete(handler as PipelineManagerEventHandler<keyof PipelineManagerEventMap>);
    };
  }

  /**
   * Remove event handlers
   */
  off<K extends keyof PipelineManagerEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private async emit<K extends keyof PipelineManagerEventMap>(
    event: K,
    payload: PipelineManagerEventMap[K]
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await (handler as PipelineManagerEventHandler<K>)(payload);
      } catch {
        // Ignore handler errors to prevent blocking
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline Operations
  // ---------------------------------------------------------------------------

  /**
   * Trigger a new pipeline run
   *
   * @param input - Trigger input (pipelineId, branch, parameters)
   * @returns Trigger result with run information
   * @throws PipelineManagerError if trigger fails
   */
  async triggerPipeline(input: TriggerInput): Promise<TriggerResult> {
    this.ensureInitialized();

    const pipelineId = input.pipelineId || this.config.defaultPipeline;
    if (!pipelineId) {
      throw new PipelineManagerError("Pipeline ID is required", "VALIDATION_ERROR");
    }

    try {
      // Trigger via provider
      const providerInput: TriggerPipelineInput = {
        pipelineId,
        branch: input.branch || this.config.defaultBranch || undefined,
        parameters: input.parameters,
        commitId: input.commitId,
      };

      const providerResult = await this.deps.provider.triggerPipeline(providerInput);

      // Get initial status from provider
      const providerRun = await this.deps.provider.getPipelineStatus({
        runId: providerResult.runId,
        providerRunId: providerResult.providerRunId,
      });

      // Create run in state machine
      const createInput: CreateRunInput = {
        id: providerResult.runId,
        providerRunId: providerResult.providerRunId,
        provider: this.deps.provider.name,
        pipelineId,
        pipelineName: providerRun.pipelineName,
        stages: providerRun.stages.map((s) => ({
          id: s.id,
          name: s.name,
          displayName: s.displayName,
          order: s.order,
          hasApprovalGate: s.hasApprovalGate,
        })),
        sourceBranch: providerRun.sourceBranch,
        targetBranch: providerRun.targetBranch,
        commitId: providerRun.commitId,
        commitMessage: providerRun.commitMessage,
        triggeredBy: input.triggeredBy ?? providerRun.triggeredBy,
        triggerReason: providerRun.triggerReason,
        parameters: input.parameters,
        webUrl: providerResult.webUrl ?? providerRun.webUrl,
        metadata: providerRun.metadata,
      };

      const run = await this.deps.stateMachine.createRun(createInput);

      // Save to store if available
      if (this.deps.store) {
        await this.deps.store.saveRun(run);
      }

      const result: TriggerResult = {
        runId: run.id,
        providerRunId: providerResult.providerRunId,
        webUrl: providerResult.webUrl,
        run,
      };

      // Emit event
      await this.emit("manager.pipeline_triggered", result);

      // Start polling if enabled
      if (this.config.autoStartPolling && this.config.polling.enabled) {
        this.startPolling(run.id);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.emit("manager.error", {
        error: err,
        context: "triggerPipeline",
      });

      throw new PipelineManagerError(
        `Failed to trigger pipeline: ${err.message}`,
        "PROVIDER_ERROR"
      );
    }
  }

  /**
   * Get the status of a pipeline run
   *
   * @param input - Status input (runId, refresh flag)
   * @returns Pipeline run or undefined if not found
   */
  async getStatus(input: GetStatusInput): Promise<PipelineRun | undefined> {
    this.ensureInitialized();

    // Try to get from state machine first
    let run = this.deps.stateMachine.getRun(input.runId);

    // If not found, try store
    if (!run && this.deps.store) {
      run = await this.deps.store.getRun(input.runId);
    }

    // If refresh requested and run exists, fetch from provider
    if (input.refresh && run) {
      run = await this.refreshStatus(run);
    }

    return run;
  }

  /**
   * Get the status of a pipeline run, throwing if not found
   */
  async getStatusOrThrow(input: GetStatusInput): Promise<PipelineRun> {
    const run = await this.getStatus(input);
    if (!run) {
      throw new PipelineManagerError(
        `Pipeline run not found: ${input.runId}`,
        "NOT_FOUND"
      );
    }
    return run;
  }

  /**
   * Refresh pipeline status from the provider
   */
  async refreshStatus(run: PipelineRun): Promise<PipelineRun> {
    this.ensureInitialized();

    try {
      const providerRun = await this.deps.provider.getPipelineStatus({
        runId: run.id,
        providerRunId: run.providerRunId,
      });

      // Update state machine with new status
      this.syncRunWithProvider(run.id, providerRun);

      const updatedRun = this.deps.stateMachine.getRun(run.id);
      if (updatedRun) {
        // Update store
        if (this.deps.store) {
          await this.deps.store.saveRun(updatedRun);
        }

        await this.emit("manager.status_refreshed", updatedRun);
        return updatedRun;
      }

      return run;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.emit("manager.error", {
        error: err,
        context: "refreshStatus",
        runId: run.id,
      });
      return run;
    }
  }

  /**
   * Synchronize local run state with provider run state
   */
  private syncRunWithProvider(runId: string, providerRun: PipelineRun): void {
    const { stateMachine } = this.deps;
    const run = stateMachine.getRun(runId);
    if (!run) return;

    // Update pipeline state if changed
    if (run.state !== providerRun.state) {
      try {
        if (stateMachine.canTransitionPipeline(run.state, providerRun.state)) {
          stateMachine.transitionPipeline(runId, providerRun.state);
        }
      } catch {
        // State transition not allowed, may be out of sync
      }
    }

    // Update stage states
    for (const providerStage of providerRun.stages) {
      const localStage = run.stages.find((s) => s.id === providerStage.id);
      if (localStage && localStage.state !== providerStage.state) {
        try {
          if (stateMachine.canTransitionStage(localStage.state, providerStage.state)) {
            stateMachine.transitionStage(runId, providerStage.id, providerStage.state, {
              approval: providerStage.approval,
              result: providerStage.result,
              error: providerStage.error,
            });
          }
        } catch {
          // State transition not allowed
        }
      }
    }

    // Update run metadata
    stateMachine.updateRun(runId, {
      startedAt: providerRun.startedAt ?? run.startedAt,
      finishedAt: providerRun.finishedAt,
      durationMs: providerRun.durationMs,
      result: providerRun.result,
    });
  }

  /**
   * Get pipeline history with filtering
   *
   * @param input - History query input
   * @returns History result with matching runs
   */
  async getHistory(input: GetHistoryInput = {}): Promise<GetHistoryResult> {
    this.ensureInitialized();

    // If no store, return runs from state machine
    if (!this.deps.store) {
      const runs = this.deps.stateMachine
        .getAllRuns()
        .filter((run) => {
          if (input.pipelineId && run.pipelineId !== input.pipelineId) return false;
          if (input.pipelineName && !run.pipelineName.toLowerCase().includes(input.pipelineName.toLowerCase())) return false;
          if (input.state && run.state !== input.state) return false;
          if (input.after && run.queuedAt < input.after) return false;
          if (input.before && run.queuedAt > input.before) return false;
          return true;
        })
        .sort((a, b) => b.queuedAt - a.queuedAt);

      const limitedRuns = input.limit ? runs.slice(0, input.limit) : runs;

      return {
        runs: limitedRuns,
        totalCount: runs.length,
        hasMore: input.limit ? runs.length > input.limit : false,
      };
    }

    // Use store for history query
    const queryOptions: QueryRunsOptions = {
      pipelineId: input.pipelineId,
      pipelineName: input.pipelineName,
      state: input.state,
      after: input.after,
      before: input.before,
      limit: input.limit,
      orderBy: "queuedAt",
      orderDirection: "desc",
    };

    const result = await this.deps.store.queryRuns(queryOptions);

    return {
      runs: result.runs,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
    };
  }

  /**
   * Get stage status within a pipeline run
   */
  async getStageStatus(runId: PipelineRunId, stageId: StageId): Promise<Stage | undefined> {
    this.ensureInitialized();

    const run = await this.getStatus({ runId });
    if (!run) return undefined;

    return run.stages.find((s) => s.id === stageId);
  }

  /**
   * Cancel a pipeline run
   */
  async cancelPipeline(runId: PipelineRunId): Promise<void> {
    this.ensureInitialized();

    const run = await this.getStatusOrThrow({ runId });

    // Cancel via provider
    await this.deps.provider.cancelPipeline({
      runId,
      providerRunId: run.providerRunId,
    });

    // Update state machine
    if (this.deps.stateMachine.canTransitionPipeline(run.state, "cancelled")) {
      await this.deps.stateMachine.transitionPipeline(runId, "cancelled");
      await this.deps.stateMachine.skipRemainingStages(runId);
    }

    // Stop polling
    this.stopPolling(runId);

    // Update store
    const updatedRun = this.deps.stateMachine.getRun(runId);
    if (updatedRun && this.deps.store) {
      await this.deps.store.saveRun(updatedRun);
    }
  }

  // ---------------------------------------------------------------------------
  // Approval Operations
  // ---------------------------------------------------------------------------

  /**
   * Handle an approval decision
   *
   * @param input - Approval input (approvalId, decision, comment)
   * @returns Approval handling result
   */
  async handleApproval(input: ApprovalInput): Promise<HandleApprovalResult> {
    this.ensureInitialized();

    const handlerInput: HandleApprovalInput = {
      approvalId: input.approvalId,
      decision: input.decision,
      comment: input.comment,
      approvedBy: input.approvedBy,
    };

    return this.deps.approvalHandler.handleApproval(handlerInput);
  }

  /**
   * Approve a pending approval
   */
  async approve(
    approvalId: ApprovalId,
    options?: { comment?: string; approvedBy?: string }
  ): Promise<HandleApprovalResult> {
    return this.handleApproval({
      approvalId,
      decision: "approve",
      comment: options?.comment,
      approvedBy: options?.approvedBy,
    });
  }

  /**
   * Reject a pending approval
   */
  async reject(
    approvalId: ApprovalId,
    options?: { comment?: string; approvedBy?: string }
  ): Promise<HandleApprovalResult> {
    return this.handleApproval({
      approvalId,
      decision: "reject",
      comment: options?.comment,
      approvedBy: options?.approvedBy,
    });
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): ApprovalRequest[] {
    this.ensureInitialized();
    return this.deps.approvalQueue.getPendingApprovals();
  }

  /**
   * Get approval by ID
   */
  getApproval(approvalId: ApprovalId): ApprovalRequest | undefined {
    this.ensureInitialized();
    return this.deps.approvalQueue.getApproval(approvalId);
  }

  // ---------------------------------------------------------------------------
  // Log Operations
  // ---------------------------------------------------------------------------

  /**
   * Get build logs for a pipeline run
   *
   * @param input - Log query input
   * @returns Log entries
   */
  async getLogs(input: GetLogsInput): Promise<GetLogsResult> {
    this.ensureInitialized();

    const run = await this.getStatus({ runId: input.runId });
    if (!run) {
      throw new PipelineManagerError(
        `Pipeline run not found: ${input.runId}`,
        "NOT_FOUND"
      );
    }

    return this.deps.provider.getLogs({
      runId: input.runId,
      providerRunId: run.providerRunId ?? input.providerRunId,
      stageId: input.stageId,
      jobId: input.jobId,
    });
  }

  // ---------------------------------------------------------------------------
  // Pipeline Definition Operations
  // ---------------------------------------------------------------------------

  /**
   * List available pipeline definitions
   */
  async listPipelines(): Promise<PipelineDefinition[]> {
    this.ensureInitialized();
    const result = await this.deps.provider.listPipelines();
    return result.pipelines;
  }

  // ---------------------------------------------------------------------------
  // Polling Operations
  // ---------------------------------------------------------------------------

  /**
   * Start polling for a pipeline run
   */
  startPolling(runId: PipelineRunId): void {
    if (this.pollingRuns.has(runId)) {
      return; // Already polling
    }

    const abortController = new AbortController();
    this.pollingRuns.set(runId, {
      abortController,
      startedAt: Date.now(),
    });

    this.emit("manager.polling_started", { runId });

    // Start polling in background
    this.pollRunStatus(runId, abortController.signal).catch(() => {
      // Ignore polling errors (handled internally)
    });
  }

  /**
   * Stop polling for a pipeline run
   */
  stopPolling(runId: PipelineRunId): void {
    const polling = this.pollingRuns.get(runId);
    if (polling) {
      polling.abortController.abort();
      this.pollingRuns.delete(runId);
      this.emit("manager.polling_stopped", { runId, reason: "cancelled" });
    }
  }

  /**
   * Check if a run is being polled
   */
  isPolling(runId: PipelineRunId): boolean {
    return this.pollingRuns.has(runId);
  }

  /**
   * Poll run status until completion or timeout
   */
  private async pollRunStatus(runId: PipelineRunId, signal: AbortSignal): Promise<void> {
    const { polling } = this.config;
    const startTime = Date.now();

    while (!signal.aborted) {
      // Check for timeout
      if (Date.now() - startTime > polling.maxDurationMs) {
        this.pollingRuns.delete(runId);
        await this.emit("manager.polling_stopped", { runId, reason: "timeout" });
        return;
      }

      try {
        const run = this.deps.stateMachine.getRun(runId);
        if (!run) {
          this.pollingRuns.delete(runId);
          return;
        }

        // Check if pipeline is complete
        if (TerminalPipelineStates.has(run.state)) {
          this.pollingRuns.delete(runId);
          await this.emit("manager.polling_stopped", { runId, reason: "completed" });
          return;
        }

        // Refresh status from provider
        await this.refreshStatus(run);

        // Use fast polling if pipeline is running
        const interval = run.state === "running"
          ? polling.fastIntervalMs
          : polling.intervalMs;

        // Wait for next poll
        await this.delay(interval, signal);
      } catch (error) {
        // Check if aborted
        if (signal.aborted) {
          return;
        }

        // Log error and continue polling
        const err = error instanceof Error ? error : new Error(String(error));
        await this.emit("manager.error", {
          error: err,
          context: "pollRunStatus",
          runId,
        });

        // Wait before retrying
        await this.delay(polling.intervalMs, signal);
      }
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        }, { once: true });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  /**
   * Get pipeline manager statistics
   */
  async getStats(): Promise<PipelineManagerStats> {
    this.ensureInitialized();

    let totalRunsStored: number | undefined;
    if (this.deps.store) {
      totalRunsStored = (await this.deps.store.getStats()).totalRuns;
    }

    return {
      activeRuns: this.pollingRuns.size,
      totalRunsTracked: this.deps.stateMachine.runCount,
      totalRunsStored,
      pendingApprovals: this.deps.approvalQueue.getPendingApprovals().length,
      provider: this.deps.provider.name,
      initialized: this.initialized,
    };
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get the provider instance
   */
  get provider(): PipelineProvider {
    return this.deps.provider;
  }

  /**
   * Get the state machine instance
   */
  get stateMachine(): PipelineStateMachine {
    return this.deps.stateMachine;
  }

  /**
   * Get the store instance (if available)
   */
  get store(): PipelineStore | undefined {
    return this.deps.store;
  }

  /**
   * Get the approval queue instance
   */
  get approvalQueue(): ApprovalQueue {
    return this.deps.approvalQueue;
  }

  /**
   * Get the notification hub instance (if available)
   */
  get notificationHub(): NotificationHub | undefined {
    return this.deps.notificationHub;
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new PipelineManagerError(
        "PipelineManager not initialized. Call initialize() first.",
        "NOT_INITIALIZED"
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new pipeline manager instance
 *
 * @param deps - Manager dependencies
 * @param config - Optional configuration
 * @returns Uninitialized manager instance (call initialize() before use)
 */
export function createPipelineManager(
  deps: PipelineManagerDependencies,
  config?: PipelineManagerConfig
): PipelineManager {
  return new PipelineManager(deps, config);
}

/**
 * Create and initialize a pipeline manager
 *
 * @param deps - Manager dependencies
 * @param config - Optional configuration
 * @returns Initialized manager instance
 */
export async function createAndInitializePipelineManager(
  deps: PipelineManagerDependencies,
  config?: PipelineManagerConfig
): Promise<PipelineManager> {
  const manager = createPipelineManager(deps, config);
  await manager.initialize();
  return manager;
}
