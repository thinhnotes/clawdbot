import * as ops from "./ops.js";
import {
  type PipelineServiceDeps,
  type PipelineEvent,
  createPipelineServiceState,
} from "./state.js";
import type { ApprovalRequest, PipelineCreate, PipelinePatch } from "./types.js";

export type { PipelineEvent, PipelineServiceDeps } from "./state.js";

/**
 * PipelineService
 * Main entry point for managing multi-stage build pipelines with approval gates.
 *
 * Provides:
 * - CRUD operations for pipelines
 * - Pipeline execution lifecycle (start, cancel)
 * - Approval workflow (approve, reject, list pending)
 * - Service lifecycle management (start, stop)
 */
export class PipelineService {
  private readonly state;

  constructor(deps: PipelineServiceDeps) {
    this.state = createPipelineServiceState(deps);
  }

  // ==========================================================================
  // Service Lifecycle
  // ==========================================================================

  /**
   * Starts the pipeline service.
   * Loads stored pipelines and begins monitoring for stage executions.
   */
  async start(): Promise<void> {
    await ops.startService(this.state);
  }

  /**
   * Stops the pipeline service.
   * Gracefully shuts down any running pipeline monitoring.
   */
  stop(): void {
    ops.stopService(this.state);
  }

  /**
   * Returns the current service status.
   */
  async status() {
    return await ops.status(this.state);
  }

  // ==========================================================================
  // Pipeline CRUD
  // ==========================================================================

  /**
   * Creates a new pipeline.
   * @param input - Pipeline configuration with stages
   * @returns Created pipeline or error
   */
  async create(input: PipelineCreate) {
    return await ops.create(this.state, input);
  }

  /**
   * Lists all pipelines.
   * @param opts - Optional filters
   * @returns List of pipelines
   */
  async list(opts?: { includeCompleted?: boolean }) {
    return await ops.list(this.state, opts);
  }

  /**
   * Gets a pipeline by ID.
   * @param id - Pipeline ID
   * @returns Pipeline or null if not found
   */
  async get(id: string) {
    return await ops.get(this.state, id);
  }

  /**
   * Updates a pipeline.
   * @param id - Pipeline ID
   * @param patch - Fields to update
   * @returns Updated pipeline or error
   */
  async update(id: string, patch: PipelinePatch) {
    return await ops.update(this.state, id, patch);
  }

  /**
   * Removes a pipeline.
   * @param id - Pipeline ID
   * @returns Success status
   */
  async remove(id: string) {
    return await ops.remove(this.state, id);
  }

  // ==========================================================================
  // Pipeline Execution
  // ==========================================================================

  /**
   * Starts a pipeline by executing its first stage.
   * @param id - Pipeline ID
   * @returns Start result with first stage info
   */
  async start_(id: string) {
    return await ops.start(this.state, id);
  }

  /**
   * Advances a pipeline to its next stage after the current stage completes.
   * @param id - Pipeline ID
   * @param opts - Optional triggeredBy info
   * @returns Advance result with next stage info
   */
  async advance(id: string, opts?: { triggeredBy?: string }) {
    return await ops.advanceStage(this.state, id, opts);
  }

  /**
   * Cancels a running pipeline.
   * @param id - Pipeline ID
   * @param opts - Optional cancellation reason
   * @returns Cancelled pipeline or error
   */
  async cancel(id: string, opts?: { reason?: string }) {
    return await ops.cancel(this.state, id, opts);
  }

  /**
   * Completes a stage execution.
   * If approval is required, returns shouldRequestApproval=true.
   * @param pipelineId - Pipeline ID
   * @param stageId - Stage ID
   * @param result - Execution result (success/failure)
   */
  async completeStage(
    pipelineId: string,
    stageId: string,
    result: { success: boolean; output?: string; error?: string }
  ) {
    return await ops.completeStage(this.state, pipelineId, stageId, result);
  }

  // ==========================================================================
  // Approval Workflow
  // ==========================================================================

  /**
   * Requests approval for a stage.
   * Transitions the stage to awaiting_approval status.
   * @param pipelineId - Pipeline ID
   * @param stageId - Stage ID
   * @param opts - Optional requestedBy info
   * @returns Approval request or error
   */
  async requestApproval(
    pipelineId: string,
    stageId: string,
    opts?: { requestedBy?: string }
  ) {
    return await ops.requestApproval(this.state, pipelineId, stageId, opts);
  }

  /**
   * Approves a stage that is awaiting approval.
   * @param pipelineId - Pipeline ID
   * @param stageId - Stage ID
   * @param opts - Approval metadata
   * @returns Approval result or error
   */
  async approve(
    pipelineId: string,
    stageId: string,
    opts?: { approvedBy?: string; comment?: string }
  ) {
    return await ops.processApproval(this.state, pipelineId, stageId, "approve", {
      processedBy: opts?.approvedBy,
      comment: opts?.comment,
    });
  }

  /**
   * Rejects a stage that is awaiting approval.
   * @param pipelineId - Pipeline ID
   * @param stageId - Stage ID
   * @param opts - Rejection metadata
   * @returns Rejection result or error
   */
  async reject(
    pipelineId: string,
    stageId: string,
    opts?: { rejectedBy?: string; comment?: string }
  ) {
    return await ops.processApproval(this.state, pipelineId, stageId, "reject", {
      processedBy: opts?.rejectedBy,
      comment: opts?.comment,
    });
  }

  /**
   * Gets all pending approval requests.
   * @returns List of pending approval requests
   */
  async getPendingApprovals(): Promise<ApprovalRequest[]> {
    return await ops.getPendingApprovals(this.state);
  }
}
