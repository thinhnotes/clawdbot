/**
 * Approval Queue Management
 *
 * This module provides approval queue management for pipeline stages.
 * It offers a higher-level API focused on approval workflows, history tracking,
 * and approval metadata management.
 */

import type {
  ApprovalAction,
  ApprovalHistoryEntry,
  ApprovalProcessorInput,
  ApprovalQueue,
  ApprovalQueueEntry,
  ApprovalResult,
} from "./approval-types.js";
import * as ops from "./ops.js";
import type {
  PipelineOperationResult,
  PipelineServiceState,
} from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import type { ApprovalRequest, ApprovalStatus, Pipeline, Stage } from "./types.js";

// ============================================================================
// Approval Queue Queries
// ============================================================================

/**
 * Gets the current approval queue with full context.
 * Returns pending approvals enriched with pipeline and stage details.
 * @param state - Pipeline service state
 * @returns Approval queue with entries and metadata
 */
export async function getApprovalQueue(
  state: PipelineServiceState
): Promise<ApprovalQueue> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const now = state.deps.nowMs();
    const pending: ApprovalQueueEntry[] = [];

    const approvalRequests = state.store?.approvalRequests ?? [];
    const pipelines = state.store?.pipelines ?? [];

    for (const request of approvalRequests) {
      if (request.status !== "pending") continue;

      const pipeline = pipelines.find((p) => p.id === request.pipelineId);
      if (!pipeline) continue;

      const stage = pipeline.stages.find((s) => s.id === request.stageId);
      if (!stage) continue;

      const entry: ApprovalQueueEntry = {
        request,
        pipeline,
        stage,
        timeRemainingMs: request.expiresAtMs
          ? Math.max(0, request.expiresAtMs - now)
          : undefined,
      };

      pending.push(entry);
    }

    // Sort by request time (oldest first)
    pending.sort((a, b) => a.request.requestedAtMs - b.request.requestedAtMs);

    return {
      pending,
      count: pending.length,
      lastUpdatedMs: now,
    };
  });
}

/**
 * Gets a specific approval request by ID.
 * @param state - Pipeline service state
 * @param requestId - Approval request ID
 * @returns Approval request or null if not found
 */
export async function getApprovalRequest(
  state: PipelineServiceState,
  requestId: string
): Promise<ApprovalRequest | null> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);
    return (
      state.store?.approvalRequests.find((r) => r.id === requestId) ?? null
    );
  });
}

/**
 * Gets pending approvals for a specific pipeline.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID to filter by
 * @returns List of pending approval requests for the pipeline
 */
export async function getPendingApprovalsForPipeline(
  state: PipelineServiceState,
  pipelineId: string
): Promise<ApprovalRequest[]> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);
    return (state.store?.approvalRequests ?? []).filter(
      (r) => r.pipelineId === pipelineId && r.status === "pending"
    );
  });
}

/**
 * Checks if a stage is awaiting approval.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @returns True if the stage has a pending approval request
 */
export async function isAwaitingApproval(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string
): Promise<boolean> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);
    return (state.store?.approvalRequests ?? []).some(
      (r) =>
        r.pipelineId === pipelineId &&
        r.stageId === stageId &&
        r.status === "pending"
    );
  });
}

// ============================================================================
// Approval Queue Operations
// ============================================================================

/**
 * Queues an approval request for a stage.
 * Creates a new approval request and transitions the stage to awaiting_approval.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @param opts - Options including requestedBy
 * @returns The created approval request or error
 */
export async function requestApproval(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  opts?: { requestedBy?: string }
): Promise<PipelineOperationResult<ApprovalRequest>> {
  // Delegate to ops.requestApproval which handles state transitions
  return await ops.requestApproval(state, pipelineId, stageId, opts);
}

/**
 * Processes an approval action using structured input.
 * Provides a unified interface for processing approvals.
 * @param state - Pipeline service state
 * @param input - Approval processor input with pipelineId, stageId, action, etc.
 * @returns Approval result
 */
export async function processApprovalRequest(
  state: PipelineServiceState,
  input: ApprovalProcessorInput
): Promise<ApprovalResult> {
  const result = await ops.processApproval(
    state,
    input.pipelineId,
    input.stageId,
    input.action,
    {
      processedBy: input.processedBy,
      comment: input.comment,
    }
  );

  const now = state.deps.nowMs();

  if (!result.ok) {
    return {
      action: input.action,
      approvedBy: input.processedBy,
      timestampMs: now,
      comment: input.comment,
      success: false,
      error: result.error,
    };
  }

  return {
    action: input.action,
    approvedBy: result.data.processedBy,
    timestampMs: now,
    comment: input.comment,
    success: true,
  };
}

/**
 * Approves a pending approval request.
 * Convenience method that wraps processApprovalRequest.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @param opts - Approval options
 * @returns Approval result
 */
export async function approve(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  opts?: { approvedBy?: string; comment?: string }
): Promise<ApprovalResult> {
  return processApprovalRequest(state, {
    pipelineId,
    stageId,
    action: "approve",
    processedBy: opts?.approvedBy ?? "unknown",
    comment: opts?.comment,
  });
}

/**
 * Rejects a pending approval request.
 * Convenience method that wraps processApprovalRequest.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @param opts - Rejection options
 * @returns Rejection result
 */
export async function reject(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  opts?: { rejectedBy?: string; comment?: string }
): Promise<ApprovalResult> {
  return processApprovalRequest(state, {
    pipelineId,
    stageId,
    action: "reject",
    processedBy: opts?.rejectedBy ?? "unknown",
    comment: opts?.comment,
  });
}

// ============================================================================
// Approval History
// ============================================================================

/**
 * Gets the approval history for all pipelines.
 * Returns processed (approved, rejected, expired) approval requests.
 * @param state - Pipeline service state
 * @param opts - Options for filtering history
 * @returns List of historical approval entries
 */
export async function getApprovalHistory(
  state: PipelineServiceState,
  opts?: {
    /** Filter by pipeline ID */
    pipelineId?: string;
    /** Filter by stage ID */
    stageId?: string;
    /** Filter by status */
    status?: ApprovalStatus;
    /** Maximum number of entries to return */
    limit?: number;
    /** Only return entries after this timestamp */
    afterMs?: number;
    /** Only return entries before this timestamp */
    beforeMs?: number;
  }
): Promise<ApprovalHistoryEntry[]> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const approvalRequests = state.store?.approvalRequests ?? [];
    let history: ApprovalHistoryEntry[] = [];

    for (const request of approvalRequests) {
      // Skip pending requests - they're not history yet
      if (request.status === "pending") continue;

      // Apply filters
      if (opts?.pipelineId && request.pipelineId !== opts.pipelineId) continue;
      if (opts?.stageId && request.stageId !== opts.stageId) continue;
      if (opts?.status && request.status !== opts.status) continue;
      if (opts?.afterMs && request.requestedAtMs < opts.afterMs) continue;
      if (opts?.beforeMs && request.requestedAtMs > opts.beforeMs) continue;

      // Determine the action taken based on status
      let action: ApprovalAction | undefined;
      if (request.status === "approved") action = "approve";
      else if (request.status === "rejected") action = "reject";

      const entry: ApprovalHistoryEntry = {
        requestId: request.id,
        pipelineId: request.pipelineId,
        stageId: request.stageId,
        status: request.status,
        requestedBy: request.requestedBy,
        requestedAtMs: request.requestedAtMs,
        processedBy: request.processedBy,
        processedAtMs: request.processedAtMs,
        action,
        comment: request.comment,
      };

      history.push(entry);
    }

    // Sort by processed time (most recent first) or requested time if not processed
    history.sort((a, b) => {
      const aTime = a.processedAtMs ?? a.requestedAtMs;
      const bTime = b.processedAtMs ?? b.requestedAtMs;
      return bTime - aTime;
    });

    // Apply limit
    if (opts?.limit && opts.limit > 0) {
      history = history.slice(0, opts.limit);
    }

    return history;
  });
}

/**
 * Gets approval history for a specific pipeline.
 * Convenience method that wraps getApprovalHistory.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param opts - Additional filter options
 * @returns List of historical approval entries for the pipeline
 */
export async function getPipelineApprovalHistory(
  state: PipelineServiceState,
  pipelineId: string,
  opts?: { limit?: number }
): Promise<ApprovalHistoryEntry[]> {
  return getApprovalHistory(state, {
    pipelineId,
    limit: opts?.limit,
  });
}

/**
 * Gets approval history for a specific stage.
 * Convenience method that wraps getApprovalHistory.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @returns List of historical approval entries for the stage
 */
export async function getStageApprovalHistory(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string
): Promise<ApprovalHistoryEntry[]> {
  return getApprovalHistory(state, {
    pipelineId,
    stageId,
  });
}

// ============================================================================
// Approval Statistics
// ============================================================================

/**
 * Approval queue statistics.
 */
export type ApprovalStats = {
  /** Total pending approvals */
  pendingCount: number;
  /** Total approved */
  approvedCount: number;
  /** Total rejected */
  rejectedCount: number;
  /** Total expired */
  expiredCount: number;
  /** Average time to approval in ms (for approved requests) */
  avgApprovalTimeMs: number | null;
  /** Average time to rejection in ms (for rejected requests) */
  avgRejectionTimeMs: number | null;
};

/**
 * Gets approval statistics.
 * @param state - Pipeline service state
 * @param opts - Options for filtering stats
 * @returns Approval statistics
 */
export async function getApprovalStats(
  state: PipelineServiceState,
  opts?: { pipelineId?: string }
): Promise<ApprovalStats> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    let requests = state.store?.approvalRequests ?? [];

    // Filter by pipeline if specified
    if (opts?.pipelineId) {
      requests = requests.filter((r) => r.pipelineId === opts.pipelineId);
    }

    let pendingCount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    let expiredCount = 0;
    let totalApprovalTimeMs = 0;
    let totalRejectionTimeMs = 0;

    for (const request of requests) {
      switch (request.status) {
        case "pending":
          pendingCount++;
          break;
        case "approved":
          approvedCount++;
          if (request.processedAtMs) {
            totalApprovalTimeMs +=
              request.processedAtMs - request.requestedAtMs;
          }
          break;
        case "rejected":
          rejectedCount++;
          if (request.processedAtMs) {
            totalRejectionTimeMs +=
              request.processedAtMs - request.requestedAtMs;
          }
          break;
        case "expired":
          expiredCount++;
          break;
      }
    }

    return {
      pendingCount,
      approvedCount,
      rejectedCount,
      expiredCount,
      avgApprovalTimeMs:
        approvedCount > 0 ? totalApprovalTimeMs / approvedCount : null,
      avgRejectionTimeMs:
        rejectedCount > 0 ? totalRejectionTimeMs / rejectedCount : null,
    };
  });
}

// ============================================================================
// Approval Request Lookup
// ============================================================================

/**
 * Finds an approval request by pipeline and stage.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param stageId - Stage ID
 * @param status - Optional status filter (defaults to "pending")
 * @returns Matching approval request or null
 */
export async function findApprovalRequest(
  state: PipelineServiceState,
  pipelineId: string,
  stageId: string,
  status?: ApprovalStatus
): Promise<ApprovalRequest | null> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const targetStatus = status ?? "pending";
    return (
      state.store?.approvalRequests.find(
        (r) =>
          r.pipelineId === pipelineId &&
          r.stageId === stageId &&
          r.status === targetStatus
      ) ?? null
    );
  });
}

/**
 * Finds an approval queue entry by request ID with full context.
 * @param state - Pipeline service state
 * @param requestId - Approval request ID
 * @returns Approval queue entry with pipeline/stage context or null
 */
export async function findApprovalQueueEntry(
  state: PipelineServiceState,
  requestId: string
): Promise<ApprovalQueueEntry | null> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const request = state.store?.approvalRequests.find(
      (r) => r.id === requestId
    );
    if (!request) return null;

    const pipeline = state.store?.pipelines.find(
      (p) => p.id === request.pipelineId
    );
    if (!pipeline) return null;

    const stage = pipeline.stages.find((s) => s.id === request.stageId);
    if (!stage) return null;

    const now = state.deps.nowMs();

    return {
      request,
      pipeline,
      stage,
      timeRemainingMs: request.expiresAtMs
        ? Math.max(0, request.expiresAtMs - now)
        : undefined,
    };
  });
}

// ============================================================================
// Approval Cancellation
// ============================================================================

/**
 * Cancels a pending approval request.
 * Marks the request as expired without processing.
 * @param state - Pipeline service state
 * @param requestId - Approval request ID
 * @param opts - Cancellation options
 * @returns Success or error
 */
export async function cancelApprovalRequest(
  state: PipelineServiceState,
  requestId: string,
  opts?: { cancelledBy?: string; reason?: string }
): Promise<PipelineOperationResult<{ cancelled: boolean }>> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const request = state.store?.approvalRequests.find(
      (r) => r.id === requestId
    );
    if (!request) {
      return { ok: false, error: `Approval request not found: ${requestId}` };
    }

    if (request.status !== "pending") {
      return {
        ok: false,
        error: `Approval request is not pending: ${request.status}`,
      };
    }

    const now = state.deps.nowMs();

    // Mark as expired
    request.status = "expired";
    request.processedAtMs = now;
    request.processedBy = opts?.cancelledBy;
    request.comment = opts?.reason ?? "Cancelled";

    await persist(state);

    // Emit cancellation event
    ops.emit(state, {
      kind: "approval_event",
      event: {
        kind: "approval_timeout",
        request,
      },
    });

    return { ok: true, data: { cancelled: true } };
  });
}

/**
 * Cancels all pending approvals for a pipeline.
 * @param state - Pipeline service state
 * @param pipelineId - Pipeline ID
 * @param opts - Cancellation options
 * @returns Number of cancelled requests
 */
export async function cancelAllPipelineApprovals(
  state: PipelineServiceState,
  pipelineId: string,
  opts?: { cancelledBy?: string; reason?: string }
): Promise<PipelineOperationResult<{ cancelledCount: number }>> {
  return await ops.locked(state, async () => {
    await ensureLoaded(state);

    const now = state.deps.nowMs();
    let cancelledCount = 0;

    const requests = state.store?.approvalRequests ?? [];
    for (const request of requests) {
      if (request.pipelineId === pipelineId && request.status === "pending") {
        request.status = "expired";
        request.processedAtMs = now;
        request.processedBy = opts?.cancelledBy;
        request.comment = opts?.reason ?? "Pipeline cancelled";
        cancelledCount++;
      }
    }

    if (cancelledCount > 0) {
      await persist(state);
    }

    return { ok: true, data: { cancelledCount } };
  });
}
