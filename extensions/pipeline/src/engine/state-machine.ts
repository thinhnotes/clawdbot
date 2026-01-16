/**
 * Pipeline State Machine
 *
 * Manages pipeline execution state transitions with validation and event emission.
 * Tracks both pipeline-level and stage-level state with granular transitions.
 *
 * Features:
 * - Validated state transitions for pipelines and stages
 * - Event emission on state changes for observers
 * - Pipeline run tracking with stage-level granularity
 * - Thread-safe state updates
 *
 * @example
 * ```typescript
 * const stateMachine = new PipelineStateMachine();
 *
 * // Register event handlers
 * stateMachine.on("pipeline.started", (run) => {
 *   console.log(`Pipeline ${run.pipelineName} started`);
 * });
 *
 * // Track a new run
 * const run = stateMachine.createRun({
 *   id: "run-1",
 *   provider: "azure-devops",
 *   pipelineId: "build",
 *   pipelineName: "Build Pipeline",
 *   stages: [],
 * });
 *
 * // Transition state
 * stateMachine.transitionPipeline(run.id, "running");
 * ```
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  PipelineEventHandler,
  PipelineEventMap,
  PipelineRun,
  PipelineState,
  ProviderName,
  Stage,
  StageState,
} from "../types.js";
import { TerminalPipelineStates, TerminalStageStates } from "../types.js";

// -----------------------------------------------------------------------------
// State Transition Definitions
// -----------------------------------------------------------------------------

/**
 * Valid pipeline state transitions.
 * Maps each state to the set of states it can transition to.
 */
export const PIPELINE_STATE_TRANSITIONS: Record<PipelineState, Set<PipelineState>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["waiting_for_approval", "succeeded", "failed", "cancelled"]),
  waiting_for_approval: new Set(["running", "failed", "cancelled"]),
  succeeded: new Set(), // Terminal state - no transitions allowed
  failed: new Set(), // Terminal state - no transitions allowed
  cancelled: new Set(), // Terminal state - no transitions allowed
  skipped: new Set(), // Terminal state - no transitions allowed
};

/**
 * Valid stage state transitions.
 * Maps each state to the set of states it can transition to.
 */
export const STAGE_STATE_TRANSITIONS: Record<StageState, Set<StageState>> = {
  pending: new Set(["queued", "running", "skipped", "cancelled"]),
  queued: new Set(["running", "skipped", "cancelled"]),
  running: new Set(["waiting_for_approval", "succeeded", "failed", "cancelled"]),
  waiting_for_approval: new Set(["approved", "rejected", "cancelled"]),
  approved: new Set(["running", "succeeded"]),
  rejected: new Set(), // Terminal state
  succeeded: new Set(), // Terminal state
  failed: new Set(), // Terminal state
  cancelled: new Set(), // Terminal state
  skipped: new Set(), // Terminal state
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Input for creating a new pipeline run
 */
export interface CreateRunInput {
  id: string;
  providerRunId?: string;
  provider: ProviderName;
  pipelineId: string;
  pipelineName: string;
  stages: Omit<Stage, "state">[];
  sourceBranch?: string;
  targetBranch?: string;
  commitId?: string;
  commitMessage?: string;
  triggeredBy?: string;
  triggerReason?: string;
  parameters?: Record<string, string>;
  webUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Error thrown when an invalid state transition is attempted
 */
export class StateTransitionError extends Error {
  constructor(
    message: string,
    public readonly runId: string,
    public readonly currentState: string,
    public readonly targetState: string,
    public readonly stageId?: string
  ) {
    super(message);
    this.name = "StateTransitionError";
  }
}

/**
 * Options for state transitions
 */
export interface TransitionOptions {
  /** Optional timestamp for the transition (defaults to Date.now()) */
  timestamp?: number;
  /** Optional error message for failed states */
  error?: string;
  /** Optional metadata to attach to the state change */
  metadata?: Record<string, unknown>;
}

/**
 * Options for stage state transitions
 */
export interface StageTransitionOptions extends TransitionOptions {
  /** Approval request for waiting_for_approval state */
  approval?: ApprovalRequest;
  /** Approval response for completed approvals */
  approvalResponse?: ApprovalResponse;
  /** Result for terminal states */
  result?: "succeeded" | "failed" | "cancelled" | "skipped";
}

// -----------------------------------------------------------------------------
// PipelineStateMachine Implementation
// -----------------------------------------------------------------------------

/**
 * State machine for tracking pipeline execution states and transitions.
 *
 * Provides:
 * - Validated state transitions for pipelines and stages
 * - Event emission on state changes
 * - Pipeline run tracking with stage-level granularity
 */
export class PipelineStateMachine {
  private readonly runs: Map<string, PipelineRun> = new Map();
  private readonly eventHandlers: Map<
    keyof PipelineEventMap,
    Set<PipelineEventHandler<keyof PipelineEventMap>>
  > = new Map();

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to state machine events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function to call when event fires
   * @returns Unsubscribe function
   */
  on<K extends keyof PipelineEventMap>(
    event: K,
    handler: PipelineEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as PipelineEventHandler<keyof PipelineEventMap>);

    return () => {
      handlers?.delete(handler as PipelineEventHandler<keyof PipelineEventMap>);
    };
  }

  /**
   * Remove all event handlers for a specific event or all events
   */
  off<K extends keyof PipelineEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private async emit<K extends keyof PipelineEventMap>(
    event: K,
    payload: PipelineEventMap[K]
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await (handler as PipelineEventHandler<K>)(payload);
      } catch {
        // Ignore handler errors to prevent one handler from blocking others
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline Run Management
  // ---------------------------------------------------------------------------

  /**
   * Create and track a new pipeline run
   *
   * @param input - Run creation input
   * @returns The created pipeline run in queued state
   */
  async createRun(input: CreateRunInput): Promise<PipelineRun> {
    const now = Date.now();

    // Initialize stages with pending state
    const stages: Stage[] = input.stages.map((stage, index) => ({
      ...stage,
      state: "pending" as StageState,
      order: stage.order ?? index,
    }));

    const run: PipelineRun = {
      id: input.id,
      providerRunId: input.providerRunId,
      provider: input.provider,
      pipelineId: input.pipelineId,
      pipelineName: input.pipelineName,
      state: "queued",
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      commitId: input.commitId,
      commitMessage: input.commitMessage,
      triggeredBy: input.triggeredBy,
      triggerReason: input.triggerReason,
      stages,
      parameters: input.parameters,
      queuedAt: now,
      webUrl: input.webUrl,
      metadata: input.metadata,
    };

    this.runs.set(run.id, run);

    // Emit queued event
    await this.emit("pipeline.queued", run);

    return run;
  }

  /**
   * Get a pipeline run by ID
   *
   * @param runId - Pipeline run ID
   * @returns Pipeline run or undefined if not found
   */
  getRun(runId: string): PipelineRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Get all tracked pipeline runs
   */
  getAllRuns(): PipelineRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * Get runs filtered by state
   */
  getRunsByState(state: PipelineState): PipelineRun[] {
    return Array.from(this.runs.values()).filter((run) => run.state === state);
  }

  /**
   * Remove a pipeline run from tracking
   *
   * @param runId - Pipeline run ID to remove
   * @returns True if run was removed, false if not found
   */
  removeRun(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /**
   * Update a pipeline run with external data (e.g., from provider status poll)
   *
   * @param runId - Pipeline run ID
   * @param updates - Partial run data to merge
   * @returns Updated run or undefined if not found
   */
  updateRun(runId: string, updates: Partial<PipelineRun>): PipelineRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    // Merge updates into run, excluding id and provider (immutable)
    const { id: _id, provider: _provider, ...rest } = updates;
    Object.assign(run, rest);

    return run;
  }

  // ---------------------------------------------------------------------------
  // State Transitions
  // ---------------------------------------------------------------------------

  /**
   * Validate if a pipeline state transition is allowed
   *
   * @param currentState - Current pipeline state
   * @param targetState - Target state to transition to
   * @returns True if transition is valid
   */
  canTransitionPipeline(currentState: PipelineState, targetState: PipelineState): boolean {
    if (currentState === targetState) return false;
    const allowedTransitions = PIPELINE_STATE_TRANSITIONS[currentState];
    return allowedTransitions.has(targetState);
  }

  /**
   * Validate if a stage state transition is allowed
   *
   * @param currentState - Current stage state
   * @param targetState - Target state to transition to
   * @returns True if transition is valid
   */
  canTransitionStage(currentState: StageState, targetState: StageState): boolean {
    if (currentState === targetState) return false;
    const allowedTransitions = STAGE_STATE_TRANSITIONS[currentState];
    return allowedTransitions.has(targetState);
  }

  /**
   * Transition a pipeline to a new state
   *
   * @param runId - Pipeline run ID
   * @param targetState - Target state to transition to
   * @param options - Optional transition options
   * @returns Updated pipeline run
   * @throws StateTransitionError if transition is invalid
   */
  async transitionPipeline(
    runId: string,
    targetState: PipelineState,
    options: TransitionOptions = {}
  ): Promise<PipelineRun> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new StateTransitionError(
        `Pipeline run not found: ${runId}`,
        runId,
        "unknown",
        targetState
      );
    }

    const currentState = run.state;

    // Validate transition
    if (!this.canTransitionPipeline(currentState, targetState)) {
      throw new StateTransitionError(
        `Invalid pipeline state transition: ${currentState} -> ${targetState}`,
        runId,
        currentState,
        targetState
      );
    }

    const timestamp = options.timestamp ?? Date.now();

    // Update state
    run.state = targetState;

    // Update timestamps based on state
    if (targetState === "running" && !run.startedAt) {
      run.startedAt = timestamp;
    }

    if (TerminalPipelineStates.has(targetState)) {
      run.finishedAt = timestamp;
      if (run.startedAt) {
        run.durationMs = timestamp - run.startedAt;
      }
      // Set result for terminal states
      if (targetState === "succeeded" || targetState === "failed" || targetState === "cancelled") {
        run.result = targetState;
      }
    }

    // Merge optional metadata
    if (options.metadata) {
      run.metadata = { ...run.metadata, ...options.metadata };
    }

    // Emit appropriate event
    if (targetState === "running" && currentState === "queued") {
      await this.emit("pipeline.started", run);
    } else if (TerminalPipelineStates.has(targetState)) {
      await this.emit("pipeline.completed", run);
    }

    return run;
  }

  /**
   * Transition a stage to a new state
   *
   * @param runId - Pipeline run ID
   * @param stageId - Stage ID within the run
   * @param targetState - Target state to transition to
   * @param options - Optional transition options
   * @returns Updated stage
   * @throws StateTransitionError if transition is invalid
   */
  async transitionStage(
    runId: string,
    stageId: string,
    targetState: StageState,
    options: StageTransitionOptions = {}
  ): Promise<Stage> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new StateTransitionError(
        `Pipeline run not found: ${runId}`,
        runId,
        "unknown",
        targetState,
        stageId
      );
    }

    const stage = run.stages.find((s) => s.id === stageId);
    if (!stage) {
      throw new StateTransitionError(
        `Stage not found: ${stageId}`,
        runId,
        "unknown",
        targetState,
        stageId
      );
    }

    const currentState = stage.state;

    // Validate transition
    if (!this.canTransitionStage(currentState, targetState)) {
      throw new StateTransitionError(
        `Invalid stage state transition: ${currentState} -> ${targetState}`,
        runId,
        currentState,
        targetState,
        stageId
      );
    }

    const timestamp = options.timestamp ?? Date.now();

    // Update state
    stage.state = targetState;

    // Update timestamps based on state
    if (targetState === "running" && !stage.startedAt) {
      stage.startedAt = timestamp;
    }

    if (TerminalStageStates.has(targetState)) {
      stage.finishedAt = timestamp;
      if (stage.startedAt) {
        stage.durationMs = timestamp - stage.startedAt;
      }
      // Set result for terminal states
      if (options.result) {
        stage.result = options.result;
      } else if (targetState === "succeeded") {
        stage.result = "succeeded";
      } else if (targetState === "failed" || targetState === "rejected") {
        stage.result = "failed";
      } else if (targetState === "cancelled") {
        stage.result = "cancelled";
      } else if (targetState === "skipped") {
        stage.result = "skipped";
      }
    }

    // Handle approval state
    if (targetState === "waiting_for_approval" && options.approval) {
      stage.approval = options.approval;
    }

    // Handle error
    if (options.error) {
      stage.error = options.error;
    }

    // Merge optional metadata
    if (options.metadata) {
      stage.metadata = { ...stage.metadata, ...options.metadata };
    }

    // Emit appropriate event
    if (targetState === "running" && (currentState === "pending" || currentState === "queued" || currentState === "approved")) {
      await this.emit("stage.started", { run, stage });
    } else if (TerminalStageStates.has(targetState)) {
      await this.emit("stage.completed", { run, stage });
    } else if (targetState === "waiting_for_approval" && options.approval) {
      await this.emit("stage.waiting_for_approval", { run, stage, approval: options.approval });
    }

    // Handle approval completion events
    if ((targetState === "approved" || targetState === "rejected") && options.approvalResponse) {
      await this.emit("approval.completed", { run, stage, response: options.approvalResponse });
    }

    return stage;
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Get a stage from a run by ID
   */
  getStage(runId: string, stageId: string): Stage | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return run.stages.find((s) => s.id === stageId);
  }

  /**
   * Get all stages for a run
   */
  getStages(runId: string): Stage[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.stages;
  }

  /**
   * Check if a pipeline is in a terminal state
   */
  isPipelineTerminal(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return TerminalPipelineStates.has(run.state);
  }

  /**
   * Check if a stage is in a terminal state
   */
  isStageTerminal(runId: string, stageId: string): boolean {
    const stage = this.getStage(runId, stageId);
    if (!stage) return false;
    return TerminalStageStates.has(stage.state);
  }

  /**
   * Get pending stages (not yet started)
   */
  getPendingStages(runId: string): Stage[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.stages.filter((s) => s.state === "pending");
  }

  /**
   * Get the next stage to execute (first pending stage)
   */
  getNextStage(runId: string): Stage | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return run.stages.find((s) => s.state === "pending");
  }

  /**
   * Get stages waiting for approval
   */
  getApprovalPendingStages(runId: string): Stage[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.stages.filter((s) => s.state === "waiting_for_approval");
  }

  /**
   * Check if all stages are complete (succeeded or skipped)
   */
  areAllStagesComplete(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.stages.every((s) => TerminalStageStates.has(s.state));
  }

  /**
   * Check if any stage has failed
   */
  hasFailedStage(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.stages.some((s) => s.state === "failed" || s.state === "rejected");
  }

  /**
   * Skip all pending stages (used when pipeline is cancelled or fails)
   */
  async skipRemainingStages(runId: string, afterStageId?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    let shouldSkip = !afterStageId; // If no afterStageId, skip all pending

    for (const stage of run.stages) {
      if (afterStageId && stage.id === afterStageId) {
        shouldSkip = true;
        continue;
      }

      if (shouldSkip && stage.state === "pending") {
        await this.transitionStage(runId, stage.id, "skipped", { result: "skipped" });
      }
    }
  }

  /**
   * Clear all tracked runs (useful for testing)
   */
  clear(): void {
    this.runs.clear();
  }

  /**
   * Get the count of tracked runs
   */
  get runCount(): number {
    return this.runs.size;
  }
}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Create a new pipeline state machine instance
 */
export function createStateMachine(): PipelineStateMachine {
  return new PipelineStateMachine();
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Check if a state is a terminal pipeline state
 */
export function isPipelineTerminalState(state: PipelineState): boolean {
  return TerminalPipelineStates.has(state);
}

/**
 * Check if a state is a terminal stage state
 */
export function isStageTerminalState(state: StageState): boolean {
  return TerminalStageStates.has(state);
}

/**
 * Get all valid transitions for a pipeline state
 */
export function getValidPipelineTransitions(state: PipelineState): PipelineState[] {
  return Array.from(PIPELINE_STATE_TRANSITIONS[state]);
}

/**
 * Get all valid transitions for a stage state
 */
export function getValidStageTransitions(state: StageState): StageState[] {
  return Array.from(STAGE_STATE_TRANSITIONS[state]);
}
