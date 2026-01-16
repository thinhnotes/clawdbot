/**
 * Approval Queue
 *
 * Manages pending stage approvals with timeout handling and notification integration.
 * Tracks approval requests, handles timeouts, and integrates with the notification hub.
 *
 * Features:
 * - Approval queue with pending approvals tracking
 * - Add/remove approval methods
 * - Query approvals by pipeline, run, or user
 * - Approval timeout handling with auto-reject option
 * - Optional integration with notification hub for alerts
 *
 * @example
 * ```typescript
 * import { ApprovalQueue, createApprovalQueue } from "./approval.js";
 *
 * // Create queue with configuration
 * const queue = createApprovalQueue({
 *   defaultTimeoutMs: 3600000, // 1 hour
 *   autoRejectOnTimeout: true,
 *   requireRejectComment: true,
 * });
 *
 * // Initialize queue
 * await queue.initialize();
 *
 * // Add an approval request
 * const approval = await queue.addApproval({
 *   runId: "run-123",
 *   stageId: "deploy",
 *   stageName: "Deploy to Production",
 *   pipelineName: "Release Pipeline",
 * });
 *
 * // Get pending approvals
 * const pending = queue.getPendingApprovals();
 *
 * // Complete an approval
 * await queue.completeApproval(approval.id, "approved", {
 *   approvedBy: "user@example.com",
 *   comment: "Verified deployment",
 * });
 * ```
 */

import { randomUUID } from "node:crypto";

import type {
  ApprovalId,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalStatus,
  PipelineRunId,
  StageId,
} from "../types.js";
import { ApprovalRequestSchema } from "../types.js";
import type { ApprovalConfig } from "../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Input for creating a new approval request
 */
export interface CreateApprovalInput {
  /** Pipeline run ID this approval belongs to */
  runId: PipelineRunId;
  /** Provider-specific run ID (optional) */
  providerRunId?: string;
  /** Stage ID requiring approval */
  stageId: StageId;
  /** Human-readable stage name */
  stageName: string;
  /** Human-readable pipeline name */
  pipelineName: string;
  /** Provider-specific approval ID for API calls */
  providerApprovalId?: string;
  /** Authorized approvers (user IDs or email addresses) */
  approvers?: string[];
  /** Instructions for the approver */
  instructions?: string;
  /** Custom timeout in milliseconds (overrides default) */
  timeoutMs?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for completing an approval
 */
export interface CompleteApprovalInput {
  /** Comment explaining the decision */
  comment?: string;
  /** User who made the decision */
  approvedBy?: string;
}

/**
 * Query options for filtering approvals
 */
export interface QueryApprovalsOptions {
  /** Filter by pipeline run ID */
  runId?: PipelineRunId;
  /** Filter by pipeline name (partial match) */
  pipelineName?: string;
  /** Filter by stage ID */
  stageId?: StageId;
  /** Filter by status */
  status?: ApprovalStatus;
  /** Filter by approver (any matching) */
  approver?: string;
  /** Only include expired approvals */
  expiredOnly?: boolean;
  /** Only include non-expired approvals */
  activeOnly?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Sort order */
  orderBy?: "requestedAt" | "expiresAt" | "pipelineName";
  /** Sort direction */
  orderDirection?: "asc" | "desc";
}

/**
 * Approval queue event types
 */
export type ApprovalQueueEventMap = {
  /** Emitted when a new approval is added */
  "approval.added": ApprovalRequest;
  /** Emitted when an approval is completed (approved/rejected) */
  "approval.completed": { approval: ApprovalRequest; response: ApprovalResponse };
  /** Emitted when an approval times out */
  "approval.timeout": ApprovalRequest;
  /** Emitted when an approval is cancelled */
  "approval.cancelled": ApprovalRequest;
};

export type ApprovalQueueEventHandler<K extends keyof ApprovalQueueEventMap> = (
  event: ApprovalQueueEventMap[K]
) => void | Promise<void>;

/**
 * Notification hub interface for approval notifications.
 * Defined here to avoid circular dependency with the notifications module.
 */
export interface ApprovalNotificationHub {
  /** Send notification for new approval request */
  notifyApprovalRequired?(approval: ApprovalRequest): Promise<void>;
  /** Send notification for approval completion */
  notifyApprovalCompleted?(approval: ApprovalRequest, response: ApprovalResponse): Promise<void>;
  /** Send notification for approval timeout */
  notifyApprovalTimeout?(approval: ApprovalRequest): Promise<void>;
}

/**
 * Statistics about the approval queue
 */
export interface ApprovalQueueStats {
  /** Total approvals tracked */
  totalApprovals: number;
  /** Approvals by status */
  byStatus: Record<ApprovalStatus, number>;
  /** Pending approvals count */
  pendingCount: number;
  /** Expired pending approvals */
  expiredPendingCount: number;
  /** Oldest pending approval timestamp */
  oldestPendingAt?: number;
  /** Newest pending approval timestamp */
  newestPendingAt?: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 3600000; // 1 hour
const TIMEOUT_CHECK_INTERVAL_MS = 30000; // 30 seconds

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by ApprovalQueue operations
 */
export class ApprovalQueueError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_EXISTS"
      | "ALREADY_COMPLETED"
      | "VALIDATION_FAILED"
      | "NOT_INITIALIZED"
      | "TIMEOUT"
      | "UNAUTHORIZED"
  ) {
    super(message);
    this.name = "ApprovalQueueError";
  }
}

// -----------------------------------------------------------------------------
// ApprovalQueue Implementation
// -----------------------------------------------------------------------------

/**
 * Queue for managing pending stage approvals.
 *
 * Provides:
 * - Approval request tracking with timeout handling
 * - Query by pipeline, run, stage, or approver
 * - Event emission for approval lifecycle
 * - Optional notification hub integration
 */
export class ApprovalQueue {
  private readonly approvals: Map<ApprovalId, ApprovalRequest> = new Map();
  private readonly eventHandlers: Map<
    keyof ApprovalQueueEventMap,
    Set<ApprovalQueueEventHandler<keyof ApprovalQueueEventMap>>
  > = new Map();
  private readonly config: Required<ApprovalConfig>;
  private notificationHub?: ApprovalNotificationHub;
  private initialized = false;
  private timeoutCheckInterval?: NodeJS.Timeout;

  constructor(config?: Partial<ApprovalConfig>) {
    // Apply defaults
    this.config = {
      defaultTimeoutMs: config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      authorizedApprovers: config?.authorizedApprovers ?? [],
      requireRejectComment: config?.requireRejectComment ?? false,
      autoRejectOnTimeout: config?.autoRejectOnTimeout ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the approval queue and start timeout checking
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Start timeout check interval
    this.timeoutCheckInterval = setInterval(() => {
      this.checkTimeouts().catch(() => {
        // Ignore timeout check errors
      });
    }, TIMEOUT_CHECK_INTERVAL_MS);

    this.initialized = true;
  }

  /**
   * Check if the queue is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Set the notification hub for approval alerts
   *
   * @param hub - Notification hub instance
   */
  setNotificationHub(hub: ApprovalNotificationHub): void {
    this.notificationHub = hub;
  }

  /**
   * Dispose the approval queue
   */
  async dispose(): Promise<void> {
    if (this.timeoutCheckInterval) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = undefined;
    }

    this.approvals.clear();
    this.eventHandlers.clear();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to approval queue events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof ApprovalQueueEventMap>(
    event: K,
    handler: ApprovalQueueEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as ApprovalQueueEventHandler<keyof ApprovalQueueEventMap>);

    return () => {
      handlers?.delete(handler as ApprovalQueueEventHandler<keyof ApprovalQueueEventMap>);
    };
  }

  /**
   * Remove event handlers
   */
  off<K extends keyof ApprovalQueueEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private async emit<K extends keyof ApprovalQueueEventMap>(
    event: K,
    payload: ApprovalQueueEventMap[K]
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await (handler as ApprovalQueueEventHandler<K>)(payload);
      } catch {
        // Ignore handler errors to prevent blocking
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Approval Management
  // ---------------------------------------------------------------------------

  /**
   * Add a new approval request to the queue
   *
   * @param input - Approval creation input
   * @returns Created approval request
   */
  async addApproval(input: CreateApprovalInput): Promise<ApprovalRequest> {
    this.ensureInitialized();

    const now = Date.now();
    const timeoutMs = input.timeoutMs ?? this.config.defaultTimeoutMs;

    const approval: ApprovalRequest = {
      id: randomUUID(),
      runId: input.runId,
      providerRunId: input.providerRunId,
      stageId: input.stageId,
      stageName: input.stageName,
      pipelineName: input.pipelineName,
      status: "pending",
      requestedAt: now,
      expiresAt: now + timeoutMs,
      approvers: input.approvers ?? this.config.authorizedApprovers,
      instructions: input.instructions,
      providerApprovalId: input.providerApprovalId,
      metadata: input.metadata,
    };

    // Validate approval
    const parseResult = ApprovalRequestSchema.safeParse(approval);
    if (!parseResult.success) {
      throw new ApprovalQueueError(
        `Invalid approval request: ${parseResult.error.message}`,
        "VALIDATION_FAILED"
      );
    }

    // Check for duplicate (same run and stage)
    const existing = this.getApprovalByRunAndStage(input.runId, input.stageId);
    if (existing && existing.status === "pending") {
      throw new ApprovalQueueError(
        `Approval already pending for run ${input.runId}, stage ${input.stageId}`,
        "ALREADY_EXISTS"
      );
    }

    const validApproval = parseResult.data;
    this.approvals.set(validApproval.id, validApproval);

    // Emit event
    await this.emit("approval.added", validApproval);

    // Send notification if hub is available
    if (this.notificationHub?.notifyApprovalRequired) {
      try {
        await this.notificationHub.notifyApprovalRequired(validApproval);
      } catch {
        // Ignore notification errors
      }
    }

    return validApproval;
  }

  /**
   * Get an approval by ID
   *
   * @param approvalId - Approval ID
   * @returns Approval or undefined if not found
   */
  getApproval(approvalId: ApprovalId): ApprovalRequest | undefined {
    this.ensureInitialized();
    return this.approvals.get(approvalId);
  }

  /**
   * Get an approval by ID, throwing if not found
   *
   * @param approvalId - Approval ID
   * @returns Approval
   * @throws ApprovalQueueError if not found
   */
  getApprovalOrThrow(approvalId: ApprovalId): ApprovalRequest {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      throw new ApprovalQueueError(`Approval not found: ${approvalId}`, "NOT_FOUND");
    }
    return approval;
  }

  /**
   * Get approval by run ID and stage ID
   *
   * @param runId - Pipeline run ID
   * @param stageId - Stage ID
   * @returns Most recent approval for the run/stage combination
   */
  getApprovalByRunAndStage(runId: PipelineRunId, stageId: StageId): ApprovalRequest | undefined {
    this.ensureInitialized();

    // Find the most recent approval for this run/stage
    let mostRecent: ApprovalRequest | undefined;
    for (const approval of this.approvals.values()) {
      if (approval.runId === runId && approval.stageId === stageId) {
        if (!mostRecent || approval.requestedAt > mostRecent.requestedAt) {
          mostRecent = approval;
        }
      }
    }
    return mostRecent;
  }

  /**
   * Get all approvals for a pipeline run
   *
   * @param runId - Pipeline run ID
   * @returns Approvals for the run
   */
  getApprovalsByRun(runId: PipelineRunId): ApprovalRequest[] {
    this.ensureInitialized();
    return Array.from(this.approvals.values())
      .filter((a) => a.runId === runId)
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }

  /**
   * Get all approvals for a pipeline (by name)
   *
   * @param pipelineName - Pipeline name (partial match, case-insensitive)
   * @returns Matching approvals
   */
  getApprovalsByPipeline(pipelineName: string): ApprovalRequest[] {
    this.ensureInitialized();
    const searchTerm = pipelineName.toLowerCase();
    return Array.from(this.approvals.values())
      .filter((a) => a.pipelineName.toLowerCase().includes(searchTerm))
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }

  /**
   * Get approvals that a user can approve
   *
   * @param userId - User ID or email to match
   * @returns Approvals the user can approve
   */
  getApprovalsByUser(userId: string): ApprovalRequest[] {
    this.ensureInitialized();
    const userLower = userId.toLowerCase();

    return Array.from(this.approvals.values())
      .filter((a) => {
        // If no approvers specified, anyone can approve
        if (!a.approvers || a.approvers.length === 0) {
          return true;
        }
        // Check if user is in the approvers list
        return a.approvers.some((approver) => approver.toLowerCase() === userLower);
      })
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals(): ApprovalRequest[] {
    this.ensureInitialized();
    return Array.from(this.approvals.values())
      .filter((a) => a.status === "pending")
      .sort((a, b) => a.requestedAt - b.requestedAt); // Oldest first
  }

  /**
   * Query approvals with filtering and sorting
   *
   * @param options - Query options
   * @returns Matching approvals
   */
  queryApprovals(options: QueryApprovalsOptions = {}): ApprovalRequest[] {
    this.ensureInitialized();
    const now = Date.now();

    let approvals = Array.from(this.approvals.values());

    // Apply filters
    if (options.runId) {
      approvals = approvals.filter((a) => a.runId === options.runId);
    }

    if (options.pipelineName) {
      const searchTerm = options.pipelineName.toLowerCase();
      approvals = approvals.filter((a) =>
        a.pipelineName.toLowerCase().includes(searchTerm)
      );
    }

    if (options.stageId) {
      approvals = approvals.filter((a) => a.stageId === options.stageId);
    }

    if (options.status) {
      approvals = approvals.filter((a) => a.status === options.status);
    }

    if (options.approver) {
      const userLower = options.approver.toLowerCase();
      approvals = approvals.filter((a) => {
        if (!a.approvers || a.approvers.length === 0) {
          return true;
        }
        return a.approvers.some((approver) => approver.toLowerCase() === userLower);
      });
    }

    if (options.expiredOnly) {
      approvals = approvals.filter(
        (a) => a.status === "pending" && a.expiresAt !== undefined && a.expiresAt < now
      );
    }

    if (options.activeOnly) {
      approvals = approvals.filter(
        (a) => a.status === "pending" && (a.expiresAt === undefined || a.expiresAt >= now)
      );
    }

    // Apply sorting
    const orderBy = options.orderBy ?? "requestedAt";
    const orderDirection = options.orderDirection ?? "desc";
    const multiplier = orderDirection === "asc" ? 1 : -1;

    approvals.sort((a, b) => {
      let aValue: number | string;
      let bValue: number | string;

      switch (orderBy) {
        case "requestedAt":
          aValue = a.requestedAt;
          bValue = b.requestedAt;
          break;
        case "expiresAt":
          aValue = a.expiresAt ?? Number.MAX_SAFE_INTEGER;
          bValue = b.expiresAt ?? Number.MAX_SAFE_INTEGER;
          break;
        case "pipelineName":
          aValue = a.pipelineName.toLowerCase();
          bValue = b.pipelineName.toLowerCase();
          break;
        default:
          aValue = a.requestedAt;
          bValue = b.requestedAt;
      }

      if (aValue < bValue) return -1 * multiplier;
      if (aValue > bValue) return 1 * multiplier;
      return 0;
    });

    // Apply limit
    if (options.limit !== undefined && options.limit > 0) {
      approvals = approvals.slice(0, options.limit);
    }

    return approvals;
  }

  /**
   * Complete an approval with a decision
   *
   * @param approvalId - Approval ID
   * @param decision - "approved" or "rejected"
   * @param options - Additional completion options
   * @returns Approval response
   */
  async completeApproval(
    approvalId: ApprovalId,
    decision: "approved" | "rejected",
    options: CompleteApprovalInput = {}
  ): Promise<ApprovalResponse> {
    this.ensureInitialized();

    const approval = this.getApprovalOrThrow(approvalId);

    // Check if already completed
    if (approval.status !== "pending") {
      throw new ApprovalQueueError(
        `Approval ${approvalId} already completed with status: ${approval.status}`,
        "ALREADY_COMPLETED"
      );
    }

    // Check authorization
    if (options.approvedBy && this.config.authorizedApprovers.length > 0) {
      const isAuthorized = this.isUserAuthorized(options.approvedBy);
      if (!isAuthorized) {
        throw new ApprovalQueueError(
          `User ${options.approvedBy} is not authorized to approve/reject`,
          "UNAUTHORIZED"
        );
      }
    }

    // Check if rejection requires comment
    if (decision === "rejected" && this.config.requireRejectComment && !options.comment) {
      throw new ApprovalQueueError(
        "A comment is required when rejecting approvals",
        "VALIDATION_FAILED"
      );
    }

    const now = Date.now();

    // Update approval status
    approval.status = decision === "approved" ? "approved" : "rejected";

    // Create response
    const response: ApprovalResponse = {
      approvalId: approval.id,
      decision: decision === "approved" ? "approve" : "reject",
      comment: options.comment,
      approvedBy: options.approvedBy,
      approvedAt: now,
    };

    // Emit event
    await this.emit("approval.completed", { approval, response });

    // Send notification if hub is available
    if (this.notificationHub?.notifyApprovalCompleted) {
      try {
        await this.notificationHub.notifyApprovalCompleted(approval, response);
      } catch {
        // Ignore notification errors
      }
    }

    return response;
  }

  /**
   * Cancel a pending approval
   *
   * @param approvalId - Approval ID
   * @returns True if cancelled, false if not found or already completed
   */
  async cancelApproval(approvalId: ApprovalId): Promise<boolean> {
    this.ensureInitialized();

    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return false;
    }

    if (approval.status !== "pending") {
      return false;
    }

    approval.status = "cancelled";

    // Emit event
    await this.emit("approval.cancelled", approval);

    return true;
  }

  /**
   * Remove an approval from the queue
   *
   * @param approvalId - Approval ID
   * @returns True if removed, false if not found
   */
  removeApproval(approvalId: ApprovalId): boolean {
    this.ensureInitialized();
    return this.approvals.delete(approvalId);
  }

  /**
   * Remove all approvals for a pipeline run
   *
   * @param runId - Pipeline run ID
   * @returns Number of approvals removed
   */
  removeApprovalsByRun(runId: PipelineRunId): number {
    this.ensureInitialized();

    const toRemove = Array.from(this.approvals.entries())
      .filter(([, approval]) => approval.runId === runId)
      .map(([id]) => id);

    for (const id of toRemove) {
      this.approvals.delete(id);
    }

    return toRemove.length;
  }

  // ---------------------------------------------------------------------------
  // Timeout Handling
  // ---------------------------------------------------------------------------

  /**
   * Check for timed out approvals and process them
   */
  async checkTimeouts(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const now = Date.now();
    const expiredApprovals = Array.from(this.approvals.values()).filter(
      (a) => a.status === "pending" && a.expiresAt !== undefined && a.expiresAt < now
    );

    for (const approval of expiredApprovals) {
      // Update status
      if (this.config.autoRejectOnTimeout) {
        approval.status = "rejected";
      } else {
        approval.status = "timeout";
      }

      // Emit event
      await this.emit("approval.timeout", approval);

      // Send notification if hub is available
      if (this.notificationHub?.notifyApprovalTimeout) {
        try {
          await this.notificationHub.notifyApprovalTimeout(approval);
        } catch {
          // Ignore notification errors
        }
      }
    }
  }

  /**
   * Check if an approval has expired
   *
   * @param approvalId - Approval ID
   * @returns True if expired
   */
  isExpired(approvalId: ApprovalId): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return false;
    }
    if (approval.expiresAt === undefined) {
      return false;
    }
    return Date.now() > approval.expiresAt;
  }

  /**
   * Get time remaining until approval expires
   *
   * @param approvalId - Approval ID
   * @returns Milliseconds remaining, or undefined if no expiry or not found
   */
  getTimeRemaining(approvalId: ApprovalId): number | undefined {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.expiresAt === undefined) {
      return undefined;
    }
    const remaining = approval.expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  /**
   * Check if a user is authorized to approve/reject
   *
   * @param userId - User ID or email
   * @returns True if authorized
   */
  isUserAuthorized(userId: string): boolean {
    // If no authorized approvers configured, anyone can approve
    if (this.config.authorizedApprovers.length === 0) {
      return true;
    }

    const userLower = userId.toLowerCase();
    return this.config.authorizedApprovers.some((approver) => {
      // Support wildcard patterns
      if (approver.includes("*")) {
        const pattern = approver.toLowerCase().replace(/\*/g, ".*");
        const regex = new RegExp(`^${pattern}$`);
        return regex.test(userLower);
      }
      return approver.toLowerCase() === userLower;
    });
  }

  /**
   * Check if a user can approve a specific approval
   *
   * @param approvalId - Approval ID
   * @param userId - User ID or email
   * @returns True if user can approve
   */
  canUserApprove(approvalId: ApprovalId, userId: string): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return false;
    }

    // Check global authorization first
    if (!this.isUserAuthorized(userId)) {
      return false;
    }

    // If approval has specific approvers, check against those
    if (approval.approvers && approval.approvers.length > 0) {
      const userLower = userId.toLowerCase();
      return approval.approvers.some((approver) => approver.toLowerCase() === userLower);
    }

    // No specific approvers = anyone authorized can approve
    return true;
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  /**
   * Get approval queue statistics
   */
  getStats(): ApprovalQueueStats {
    this.ensureInitialized();

    const approvals = Array.from(this.approvals.values());
    const now = Date.now();

    const byStatus: Record<ApprovalStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      timeout: 0,
      cancelled: 0,
    };

    let pendingCount = 0;
    let expiredPendingCount = 0;
    let oldestPendingAt: number | undefined;
    let newestPendingAt: number | undefined;

    for (const approval of approvals) {
      byStatus[approval.status]++;

      if (approval.status === "pending") {
        pendingCount++;

        if (approval.expiresAt !== undefined && approval.expiresAt < now) {
          expiredPendingCount++;
        }

        if (oldestPendingAt === undefined || approval.requestedAt < oldestPendingAt) {
          oldestPendingAt = approval.requestedAt;
        }
        if (newestPendingAt === undefined || approval.requestedAt > newestPendingAt) {
          newestPendingAt = approval.requestedAt;
        }
      }
    }

    return {
      totalApprovals: approvals.length,
      byStatus,
      pendingCount,
      expiredPendingCount,
      oldestPendingAt,
      newestPendingAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Get the count of approvals in the queue
   */
  get approvalCount(): number {
    return this.approvals.size;
  }

  /**
   * Clear all approvals (useful for testing)
   */
  clear(): void {
    this.approvals.clear();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new ApprovalQueueError(
        "ApprovalQueue not initialized. Call initialize() first.",
        "NOT_INITIALIZED"
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new approval queue instance
 *
 * @param config - Optional configuration
 * @returns Uninitialized queue instance (call initialize() before use)
 */
export function createApprovalQueue(config?: Partial<ApprovalConfig>): ApprovalQueue {
  return new ApprovalQueue(config);
}

/**
 * Create and initialize an approval queue
 *
 * @param config - Optional configuration
 * @returns Initialized queue instance
 */
export async function createAndInitializeApprovalQueue(
  config?: Partial<ApprovalConfig>
): Promise<ApprovalQueue> {
  const queue = createApprovalQueue(config);
  await queue.initialize();
  return queue;
}
