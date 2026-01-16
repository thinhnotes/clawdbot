import crypto from "node:crypto";

import type {
  ApprovalRequest,
  Pipeline,
  PipelineCreate,
  PipelinePatch,
  Stage,
  StageCreate,
  StageStatus,
  StageTransition,
} from "./types.js";
import { VALID_STAGE_TRANSITIONS } from "./types.js";
import type {
  ApprovalProcessResult,
  PipelineAdvanceResult,
  PipelineCreateResult,
  PipelineEvent,
  PipelineGetResult,
  PipelineListResult,
  PipelineOperationResult,
  PipelineServiceState,
  PipelineStartResult,
  PipelineStatusSummary,
} from "./state.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";

// ============================================================================
// Locking Utility
// ============================================================================

/**
 * Serializes operations to prevent concurrent modifications.
 * Matches the pattern from src/cron/service/locked.ts
 */
export async function locked<T>(
  state: PipelineServiceState,
  fn: () => Promise<T>
): Promise<T> {
  const next = state.op.then(fn, fn);
  // Keep the chain alive even when the operation fails.
  state.op = next.then(
    () => undefined,
    () => undefined
  );
  return (await next) as T;
}

// ============================================================================
// Event Utilities
// ============================================================================

/**
 * Emits a pipeline event to the registered handler.
 */
export function emit(state: PipelineServiceState, event: PipelineEvent) {
  if (state.deps.onEvent) {
    state.deps.onEvent(event);
  }
}

// ============================================================================
// Pipeline Lookup Helpers
// ============================================================================

/**
 * Finds a pipeline by ID or throws an error.
 */
export function findPipelineOrThrow(
  state: PipelineServiceState,
  id: string
): Pipeline {
  const pipeline = state.store?.pipelines.find((p) => p.id === id);
  if (!pipeline) throw new Error(`unknown pipeline id: ${id}`);
  return pipeline;
}

/**
 * Finds a stage in a pipeline by ID or throws an error.
 */
export function findStageOrThrow(pipeline: Pipeline, stageId: string): Stage {
  const stage = pipeline.stages.find((s) => s.id === stageId);
  if (!stage)
    throw new Error(
      `unknown stage id: ${stageId} in pipeline: ${pipeline.id}`
    );
  return stage;
}

/**
 * Finds the next stage in order after the given stage.
 */
export function findNextStage(
  pipeline: Pipeline,
  currentStageId: string
): Stage | null {
  const currentStage = findStageOrThrow(pipeline, currentStageId);
  const sortedStages = [...pipeline.stages].sort((a, b) => a.order - b.order);
  const currentIndex = sortedStages.findIndex((s) => s.id === currentStageId);
  if (currentIndex === -1 || currentIndex === sortedStages.length - 1) {
    return null;
  }
  return sortedStages[currentIndex + 1];
}

/**
 * Finds the first stage in order.
 */
export function findFirstStage(pipeline: Pipeline): Stage | null {
  if (pipeline.stages.length === 0) return null;
  const sortedStages = [...pipeline.stages].sort((a, b) => a.order - b.order);
  return sortedStages[0];
}

// ============================================================================
// Stage Creation
// ============================================================================

/**
 * Creates a Stage from StageCreate input.
 */
export function createStageFromInput(input: StageCreate): Stage {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    status: input.status ?? "pending",
    order: input.order,
    dependencies: input.dependencies,
    executor: input.executor,
    approvalConfig: input.approvalConfig,
    state: {
      ...input.state,
    },
  };
}

/**
 * Creates a new Pipeline from PipelineCreate input.
 */
export function createPipelineFromInput(
  state: PipelineServiceState,
  input: PipelineCreate
): Pipeline {
  const now = state.deps.nowMs();
  const id = crypto.randomUUID();
  const stages = input.stages.map(createStageFromInput);

  return {
    id,
    name: input.name.trim(),
    description: input.description?.trim(),
    status: input.status ?? "pending",
    createdAtMs: now,
    updatedAtMs: now,
    stages,
    currentStageId: undefined,
    config: input.config,
  };
}

// ============================================================================
// State Transition Validation
// ============================================================================

/**
 * Validates and returns whether a stage transition is allowed.
 */
export function validateStageTransition(
  from: StageStatus,
  to: StageStatus
): boolean {
  return VALID_STAGE_TRANSITIONS[from].includes(to);
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Creates a new pipeline.
 */
export async function create(
  state: PipelineServiceState,
  input: PipelineCreate
): Promise<PipelineCreateResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "create");
    await ensureLoaded(state);

    // Validate input
    if (!input.name || input.name.trim().length === 0) {
      return { ok: false, error: "Pipeline name is required" };
    }
    if (!input.stages || input.stages.length === 0) {
      return { ok: false, error: "Pipeline must have at least one stage" };
    }

    const pipeline = createPipelineFromInput(state, input);
    state.store?.pipelines.push(pipeline);
    await persist(state);

    emit(state, {
      kind: "pipeline_created",
      pipelineId: pipeline.id,
      name: pipeline.name,
    });

    return { ok: true, data: pipeline };
  });
}

/**
 * Lists all pipelines.
 */
export async function list(
  state: PipelineServiceState,
  opts?: { includeCompleted?: boolean }
): Promise<PipelineListResult> {
  return await locked(state, async () => {
    await ensureLoaded(state);
    const includeCompleted = opts?.includeCompleted === true;
    const pipelines = (state.store?.pipelines ?? []).filter(
      (p) => includeCompleted || (p.status !== "completed" && p.status !== "failed" && p.status !== "cancelled")
    );
    return pipelines.sort((a, b) => b.createdAtMs - a.createdAtMs);
  });
}

/**
 * Gets a pipeline by ID.
 */
export async function get(
  state: PipelineServiceState,
  id: string
): Promise<PipelineGetResult> {
  return await locked(state, async () => {
    await ensureLoaded(state);
    return state.store?.pipelines.find((p) => p.id === id) ?? null;
  });
}

/**
 * Updates a pipeline.
 */
export async function update(
  state: PipelineServiceState,
  id: string,
  patch: PipelinePatch
): Promise<PipelineOperationResult<Pipeline>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "update");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === id);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${id}` };
    }

    const now = state.deps.nowMs();

    // Apply patch
    if (patch.name !== undefined) pipeline.name = patch.name.trim();
    if (patch.description !== undefined)
      pipeline.description = patch.description?.trim();
    if (patch.status !== undefined) pipeline.status = patch.status;
    if (patch.currentStageId !== undefined)
      pipeline.currentStageId = patch.currentStageId;
    if (patch.config !== undefined) pipeline.config = patch.config;
    pipeline.updatedAtMs = now;

    await persist(state);

    return { ok: true, data: pipeline };
  });
}

/**
 * Removes a pipeline.
 */
export async function remove(
  state: PipelineServiceState,
  id: string
): Promise<PipelineOperationResult<{ removed: boolean }>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state);

    if (!state.store) {
      return { ok: false, error: "Store not initialized" };
    }

    const before = state.store.pipelines.length;
    state.store.pipelines = state.store.pipelines.filter((p) => p.id !== id);
    // Also remove associated approval requests
    state.store.approvalRequests = state.store.approvalRequests.filter(
      (r) => r.pipelineId !== id
    );
    const removed = state.store.pipelines.length !== before;

    await persist(state);

    return { ok: true, data: { removed } };
  });
}

// ============================================================================
// Pipeline Lifecycle Operations
// ============================================================================

/**
 * Starts a pipeline by transitioning it to running and executing the first stage.
 */
export async function start(
  state: PipelineServiceState,
  id: string
): Promise<PipelineStartResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "start");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === id);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${id}` };
    }

    if (pipeline.status !== "pending") {
      return {
        ok: false,
        error: `Pipeline cannot be started from status: ${pipeline.status}`,
      };
    }

    const firstStage = findFirstStage(pipeline);
    if (!firstStage) {
      return { ok: false, error: "Pipeline has no stages" };
    }

    const now = state.deps.nowMs();

    // Update pipeline status
    pipeline.status = "running";
    pipeline.currentStageId = firstStage.id;
    pipeline.updatedAtMs = now;

    // Transition first stage to running
    firstStage.status = "running";
    firstStage.state.startedAtMs = now;

    await persist(state);

    emit(state, {
      kind: "pipeline_started",
      pipelineId: pipeline.id,
      name: pipeline.name,
    });

    emit(state, {
      kind: "stage_started",
      pipelineId: pipeline.id,
      stageId: firstStage.id,
      stageName: firstStage.name,
    });

    return {
      ok: true,
      data: { pipeline, startedStageId: firstStage.id },
    };
  });
}

/**
 * Transitions a stage to a new status with validation.
 */
export async function transitionStage(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  toStatus: StageStatus,
  opts?: { triggeredBy?: string; reason?: string }
): Promise<PipelineOperationResult<StageTransition>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "transitionStage");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${pipelineId}` };
    }

    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) {
      return { ok: false, error: `Stage not found: ${stageId}` };
    }

    const fromStatus = stage.status;

    // Validate transition
    if (!validateStageTransition(fromStatus, toStatus)) {
      return {
        ok: false,
        error: `Invalid stage transition: ${fromStatus} → ${toStatus}`,
      };
    }

    const now = state.deps.nowMs();
    const transition: StageTransition = {
      pipelineId,
      stageId,
      fromStatus,
      toStatus,
      timestamp: now,
      triggeredBy: opts?.triggeredBy,
      reason: opts?.reason,
    };

    // Apply transition
    stage.status = toStatus;
    pipeline.updatedAtMs = now;

    // Update stage state based on transition
    if (toStatus === "running") {
      stage.state.startedAtMs = now;
    } else if (
      toStatus === "completed" ||
      toStatus === "failed" ||
      toStatus === "rejected"
    ) {
      stage.state.completedAtMs = now;
    }

    await persist(state);

    emit(state, {
      kind: "stage_transitioned",
      transition,
    });

    return { ok: true, data: transition };
  });
}

/**
 * Advances to the next stage after the current stage is completed/approved.
 */
export async function advanceStage(
  state: PipelineServiceState,
  pipelineId: string,
  opts?: { triggeredBy?: string }
): Promise<PipelineAdvanceResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "advanceStage");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${pipelineId}` };
    }

    if (!pipeline.currentStageId) {
      return { ok: false, error: "Pipeline has no current stage" };
    }

    const currentStage = pipeline.stages.find(
      (s) => s.id === pipeline.currentStageId
    );
    if (!currentStage) {
      return { ok: false, error: "Current stage not found" };
    }

    // Current stage must be completed or approved to advance
    if (
      currentStage.status !== "completed" &&
      currentStage.status !== "approved"
    ) {
      return {
        ok: false,
        error: `Cannot advance: current stage status is ${currentStage.status}`,
      };
    }

    const nextStage = findNextStage(pipeline, currentStage.id);
    const now = state.deps.nowMs();

    if (!nextStage) {
      // Pipeline completed
      pipeline.status = "completed";
      pipeline.currentStageId = undefined;
      pipeline.updatedAtMs = now;

      await persist(state);

      emit(state, {
        kind: "pipeline_completed",
        pipelineId: pipeline.id,
        name: pipeline.name,
        success: true,
      });

      return {
        ok: true,
        data: {
          pipeline,
          previousStageId: currentStage.id,
          nextStageId: null,
        },
      };
    }

    // Advance to next stage
    pipeline.currentStageId = nextStage.id;
    pipeline.updatedAtMs = now;
    nextStage.status = "running";
    nextStage.state.startedAtMs = now;

    await persist(state);

    emit(state, {
      kind: "stage_started",
      pipelineId: pipeline.id,
      stageId: nextStage.id,
      stageName: nextStage.name,
    });

    return {
      ok: true,
      data: {
        pipeline,
        previousStageId: currentStage.id,
        nextStageId: nextStage.id,
      },
    };
  });
}

/**
 * Marks a stage as awaiting approval and creates an approval request.
 */
export async function requestApproval(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  opts?: { requestedBy?: string }
): Promise<PipelineOperationResult<ApprovalRequest>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "requestApproval");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${pipelineId}` };
    }

    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) {
      return { ok: false, error: `Stage not found: ${stageId}` };
    }

    // Stage must be running to request approval
    if (stage.status !== "running") {
      return {
        ok: false,
        error: `Cannot request approval: stage status is ${stage.status}`,
      };
    }

    const now = state.deps.nowMs();

    // Transition stage to awaiting_approval
    stage.status = "awaiting_approval";
    pipeline.updatedAtMs = now;

    // Create approval request
    const approvalRequest: ApprovalRequest = {
      id: crypto.randomUUID(),
      pipelineId,
      stageId,
      status: "pending",
      requestedAtMs: now,
      requestedBy: opts?.requestedBy,
      expiresAtMs: stage.approvalConfig.timeoutMs
        ? now + stage.approvalConfig.timeoutMs
        : undefined,
    };

    state.store?.approvalRequests.push(approvalRequest);

    await persist(state);

    emit(state, {
      kind: "stage_transitioned",
      transition: {
        pipelineId,
        stageId,
        fromStatus: "running",
        toStatus: "awaiting_approval",
        timestamp: now,
        triggeredBy: opts?.requestedBy,
      },
    });

    emit(state, {
      kind: "approval_event",
      event: {
        kind: "approval_requested",
        request: approvalRequest,
      },
    });

    return { ok: true, data: approvalRequest };
  });
}

/**
 * Processes an approval action (approve or reject).
 */
export async function processApproval(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  action: "approve" | "reject",
  opts?: { processedBy?: string; comment?: string }
): Promise<ApprovalProcessResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "processApproval");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${pipelineId}` };
    }

    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) {
      return { ok: false, error: `Stage not found: ${stageId}` };
    }

    // Stage must be awaiting approval
    if (stage.status !== "awaiting_approval") {
      return {
        ok: false,
        error: `Stage is not awaiting approval: ${stage.status}`,
      };
    }

    const now = state.deps.nowMs();

    // Find and update approval request
    const approvalRequest = state.store?.approvalRequests.find(
      (r) =>
        r.pipelineId === pipelineId &&
        r.stageId === stageId &&
        r.status === "pending"
    );

    if (approvalRequest) {
      approvalRequest.status = action === "approve" ? "approved" : "rejected";
      approvalRequest.processedAtMs = now;
      approvalRequest.processedBy = opts?.processedBy;
      approvalRequest.comment = opts?.comment;
    }

    // Transition stage based on action
    const toStatus: StageStatus = action === "approve" ? "approved" : "rejected";
    stage.status = toStatus;
    pipeline.updatedAtMs = now;

    // If rejected and stopOnFailure, fail the pipeline
    if (action === "reject" && pipeline.config.stopOnFailure) {
      pipeline.status = "failed";
    }

    await persist(state);

    emit(state, {
      kind: "stage_transitioned",
      transition: {
        pipelineId,
        stageId,
        fromStatus: "awaiting_approval",
        toStatus,
        timestamp: now,
        triggeredBy: opts?.processedBy,
        reason: opts?.comment,
      },
    });

    if (approvalRequest) {
      emit(state, {
        kind: "approval_event",
        event: {
          kind: "approval_processed",
          request: approvalRequest,
          result: {
            action,
            approvedBy: opts?.processedBy ?? "unknown",
            timestampMs: now,
            comment: opts?.comment,
            success: true,
          },
        },
      });
    }

    return {
      ok: true,
      data: {
        pipelineId,
        stageId,
        action,
        processedBy: opts?.processedBy ?? "unknown",
      },
    };
  });
}

/**
 * Marks a stage as completed.
 */
export async function completeStage(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  result: { success: boolean; output?: string; error?: string }
): Promise<PipelineOperationResult<{ shouldRequestApproval: boolean }>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "completeStage");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${pipelineId}` };
    }

    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) {
      return { ok: false, error: `Stage not found: ${stageId}` };
    }

    // Stage must be running
    if (stage.status !== "running") {
      return {
        ok: false,
        error: `Stage is not running: ${stage.status}`,
      };
    }

    const now = state.deps.nowMs();

    // Determine outcome based on result and approval requirements
    if (!result.success) {
      // Stage failed
      stage.status = "failed";
      stage.state.completedAtMs = now;
      stage.state.error = result.error;
      stage.state.output = result.output;
      pipeline.updatedAtMs = now;

      if (pipeline.config.stopOnFailure) {
        pipeline.status = "failed";
      }

      await persist(state);

      emit(state, {
        kind: "stage_completed",
        pipelineId: pipeline.id,
        stageId: stage.id,
        stageName: stage.name,
        success: false,
        error: result.error,
      });

      return { ok: true, data: { shouldRequestApproval: false } };
    }

    // Stage succeeded - check if approval is required
    if (stage.approvalConfig.required) {
      // Don't complete yet, caller should request approval
      return { ok: true, data: { shouldRequestApproval: true } };
    }

    // Complete without approval
    stage.status = "completed";
    stage.state.completedAtMs = now;
    stage.state.output = result.output;
    pipeline.updatedAtMs = now;

    await persist(state);

    emit(state, {
      kind: "stage_completed",
      pipelineId: pipeline.id,
      stageId: stage.id,
      stageName: stage.name,
      success: true,
    });

    return { ok: true, data: { shouldRequestApproval: false } };
  });
}

/**
 * Cancels a running pipeline.
 */
export async function cancel(
  state: PipelineServiceState,
  id: string,
  opts?: { reason?: string }
): Promise<PipelineOperationResult<Pipeline>> {
  return await locked(state, async () => {
    warnIfDisabled(state, "cancel");
    await ensureLoaded(state);

    const pipeline = state.store?.pipelines.find((p) => p.id === id);
    if (!pipeline) {
      return { ok: false, error: `Pipeline not found: ${id}` };
    }

    if (
      pipeline.status === "completed" ||
      pipeline.status === "failed" ||
      pipeline.status === "cancelled"
    ) {
      return {
        ok: false,
        error: `Pipeline is already in terminal state: ${pipeline.status}`,
      };
    }

    const now = state.deps.nowMs();

    pipeline.status = "cancelled";
    pipeline.updatedAtMs = now;

    // Cancel any pending approval requests
    if (state.store) {
      for (const request of state.store.approvalRequests) {
        if (request.pipelineId === id && request.status === "pending") {
          request.status = "expired";
          request.processedAtMs = now;
        }
      }
    }

    await persist(state);

    emit(state, {
      kind: "pipeline_cancelled",
      pipelineId: pipeline.id,
      name: pipeline.name,
      reason: opts?.reason,
    });

    return { ok: true, data: pipeline };
  });
}

// ============================================================================
// Status Operations
// ============================================================================

/**
 * Gets a summary of the pipeline service status.
 */
export async function status(
  state: PipelineServiceState
): Promise<PipelineStatusSummary> {
  return await locked(state, async () => {
    await ensureLoaded(state);
    const pipelines = state.store?.pipelines ?? [];
    const approvalRequests = state.store?.approvalRequests ?? [];

    return {
      enabled: state.deps.pipelineEnabled,
      storePath: state.deps.storePath,
      pipelineCount: pipelines.length,
      runningCount: pipelines.filter((p) => p.status === "running").length,
      pendingApprovalCount: approvalRequests.filter(
        (r) => r.status === "pending"
      ).length,
    };
  });
}

/**
 * Gets all pending approval requests.
 */
export async function getPendingApprovals(
  state: PipelineServiceState
): Promise<ApprovalRequest[]> {
  return await locked(state, async () => {
    await ensureLoaded(state);
    return (state.store?.approvalRequests ?? []).filter(
      (r) => r.status === "pending"
    );
  });
}

// ============================================================================
// Service Lifecycle
// ============================================================================

/**
 * Starts the pipeline service.
 */
export async function startService(state: PipelineServiceState): Promise<void> {
  return await locked(state, async () => {
    if (!state.deps.pipelineEnabled) {
      state.deps.log.info({ enabled: false }, "pipeline: disabled");
      return;
    }

    await ensureLoaded(state);
    state.running = true;

    state.deps.log.info(
      {
        enabled: true,
        pipelines: state.store?.pipelines.length ?? 0,
        pendingApprovals:
          state.store?.approvalRequests.filter((r) => r.status === "pending")
            .length ?? 0,
      },
      "pipeline: started"
    );
  });
}

/**
 * Stops the pipeline service.
 */
export function stopService(state: PipelineServiceState): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.deps.log.info({}, "pipeline: stopped");
}
