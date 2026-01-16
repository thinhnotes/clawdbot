/**
 * Approval Decision Handler
 *
 * Handles approve/reject decisions for pipeline stages and propagates them
 * to providers. Coordinates between the approval queue, state machine,
 * pipeline store, and provider layer.
 *
 * Responsibilities:
 * - Process approval decisions (approve/reject)
 * - Update pipeline state machine with decision outcomes
 * - Notify providers of decisions via their approval APIs
 * - Log decisions with full audit trail
 * - Handle authorization checks before processing
 *
 * @example
 * ```typescript
 * import { ApprovalHandler, createApprovalHandler } from "./approval-handler.js";
 *
 * // Create handler with dependencies
 * const handler = createApprovalHandler({
 *   approvalQueue,
 *   stateMachine,
 *   store,
 *   getProvider: (name) => providerRegistry.get(name),
 * });
 *
 * // Initialize handler
 * await handler.initialize();
 *
 * // Handle an approval decision
 * const result = await handler.handleApproval({
 *   approvalId: "approval-123",
 *   decision: "approve",
 *   comment: "LGTM",
 *   approvedBy: "user@example.com",
 * });
 *
 * // Handle a rejection
 * await handler.handleApproval({
 *   approvalId: "approval-456",
 *   decision: "reject",
 *   comment: "Missing test coverage",
 *   approvedBy: "reviewer@example.com",
 * });
 * ```
 */

import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  ApprovalResponse,
  PipelineRun,
  ProviderName,
  Stage,
} from "../types.js";
import type { PipelineProvider } from "../providers/base.js";
import type { ApprovalQueue } from "./approval.js";
import type { PipelineStateMachine } from "./state-machine.js";
import type { PipelineStore } from "./store.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Input for handling an approval decision
 */
export interface HandleApprovalInput {
  /** Approval ID to process */
  approvalId: ApprovalId;
  /** Decision: "approve" or "reject" */
  decision: ApprovalDecision;
  /** Comment explaining the decision */
  comment?: string;
  /** User making the decision (email or username) */
  approvedBy?: string;
}

/**
 * Result of handling an approval decision
 */
export interface HandleApprovalResult {
  /** Whether the decision was processed successfully */
  success: boolean;
  /** Approval request that was processed */
  approval: ApprovalRequest;
  /** Response generated from the decision */
  response: ApprovalResponse;
  /** Updated pipeline run (if available) */
  run?: PipelineRun;
  /** Updated stage (if available) */
  stage?: Stage;
  /** Error message if processing failed */
  error?: string;
  /** Audit log entry for the decision */
  auditEntry: ApprovalAuditEntry;
}

/**
 * Audit log entry for approval decisions
 */
export interface ApprovalAuditEntry {
  /** Unique audit entry ID */
  id: string;
  /** Timestamp of the decision */
  timestamp: number;
  /** Approval ID */
  approvalId: ApprovalId;
  /** Pipeline run ID */
  runId: string;
  /** Stage ID */
  stageId: string;
  /** Pipeline name */
  pipelineName: string;
  /** Stage name */
  stageName: string;
  /** Decision made */
  decision: ApprovalDecision;
  /** Who made the decision */
  approvedBy?: string;
  /** Comment on the decision */
  comment?: string;
  /** Provider name */
  provider?: ProviderName;
  /** Whether provider was notified successfully */
  providerNotified: boolean;
  /** Provider notification error (if any) */
  providerError?: string;
  /** Whether state machine was updated */
  stateUpdated: boolean;
  /** Whether store was updated */
  storeUpdated: boolean;
  /** Duration of processing in milliseconds */
  durationMs: number;
}

/**
 * Callback function for approval decision events
 */
export type ApprovalDecisionCallback = (result: HandleApprovalResult) => void | Promise<void>;

/**
 * Handler event types
 */
export type ApprovalHandlerEventMap = {
  /** Emitted when an approval decision is processed */
  "decision.processed": HandleApprovalResult;
  /** Emitted when provider notification fails (but local processing succeeded) */
  "provider.notification_failed": {
    approval: ApprovalRequest;
    error: Error;
    provider: ProviderName;
  };
  /** Emitted when an error occurs during processing */
  "error": {
    approvalId: ApprovalId;
    error: Error;
    context: string;
  };
};

export type ApprovalHandlerEventHandler<K extends keyof ApprovalHandlerEventMap> = (
  event: ApprovalHandlerEventMap[K]
) => void | Promise<void>;

/**
 * Configuration for the approval handler
 */
export interface ApprovalHandlerConfig {
  /** Whether to require provider confirmation before updating local state */
  requireProviderConfirmation?: boolean;
  /** Timeout for provider API calls in milliseconds */
  providerTimeoutMs?: number;
  /** Maximum retry attempts for provider calls */
  maxRetries?: number;
  /** Whether to log audit entries */
  enableAuditLog?: boolean;
  /** Maximum audit log entries to keep in memory */
  maxAuditLogSize?: number;
}

/**
 * Dependencies required by the approval handler
 */
export interface ApprovalHandlerDependencies {
  /** Approval queue for managing pending approvals */
  approvalQueue: ApprovalQueue;
  /** State machine for tracking pipeline states */
  stateMachine: PipelineStateMachine;
  /** Store for persisting pipeline runs (optional) */
  store?: PipelineStore;
  /** Function to get a provider by name */
  getProvider: (name: ProviderName) => PipelineProvider | undefined;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_PROVIDER_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_AUDIT_LOG_SIZE = 1000;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by approval handler operations
 */
export class ApprovalHandlerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_PROCESSED"
      | "UNAUTHORIZED"
      | "PROVIDER_ERROR"
      | "STATE_ERROR"
      | "VALIDATION_ERROR"
      | "TIMEOUT"
      | "NOT_INITIALIZED"
  ) {
    super(message);
    this.name = "ApprovalHandlerError";
  }
}

// -----------------------------------------------------------------------------
// ApprovalHandler Implementation
// -----------------------------------------------------------------------------

/**
 * Handles approval decisions and coordinates between components.
 *
 * Provides:
 * - Process approval/rejection decisions
 * - Update state machine with outcomes
 * - Notify providers via their APIs
 * - Maintain audit trail
 * - Event emission for monitoring
 */
export class ApprovalHandler {
  private readonly config: Required<ApprovalHandlerConfig>;
  private readonly deps: ApprovalHandlerDependencies;
  private readonly eventHandlers: Map<
    keyof ApprovalHandlerEventMap,
    Set<ApprovalHandlerEventHandler<keyof ApprovalHandlerEventMap>>
  > = new Map();
  private readonly auditLog: ApprovalAuditEntry[] = [];
  private initialized = false;

  constructor(deps: ApprovalHandlerDependencies, config?: ApprovalHandlerConfig) {
    this.deps = deps;
    this.config = {
      requireProviderConfirmation: config?.requireProviderConfirmation ?? false,
      providerTimeoutMs: config?.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
      enableAuditLog: config?.enableAuditLog ?? true,
      maxAuditLogSize: config?.maxAuditLogSize ?? DEFAULT_MAX_AUDIT_LOG_SIZE,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the approval handler
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
  }

  /**
   * Check if the handler is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose the handler and cleanup resources
   */
  async dispose(): Promise<void> {
    this.eventHandlers.clear();
    this.auditLog.length = 0;
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to handler events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof ApprovalHandlerEventMap>(
    event: K,
    handler: ApprovalHandlerEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as ApprovalHandlerEventHandler<keyof ApprovalHandlerEventMap>);

    return () => {
      handlers?.delete(handler as ApprovalHandlerEventHandler<keyof ApprovalHandlerEventMap>);
    };
  }

  /**
   * Remove event handlers
   */
  off<K extends keyof ApprovalHandlerEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private async emit<K extends keyof ApprovalHandlerEventMap>(
    event: K,
    payload: ApprovalHandlerEventMap[K]
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await (handler as ApprovalHandlerEventHandler<K>)(payload);
      } catch {
        // Ignore handler errors to prevent blocking
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main Approval Handling
  // ---------------------------------------------------------------------------

  /**
   * Handle an approval decision
   *
   * This is the main entry point for processing approval/rejection decisions.
   * It coordinates between the approval queue, provider, state machine, and store.
   *
   * @param input - Approval decision input
   * @returns Result of the approval handling
   * @throws ApprovalHandlerError if processing fails
   */
  async handleApproval(input: HandleApprovalInput): Promise<HandleApprovalResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const auditEntry = this.createAuditEntry(input.approvalId);

    try {
      // 1. Get and validate the approval
      const approval = this.deps.approvalQueue.getApprovalOrThrow(input.approvalId);

      // Update audit entry with approval details
      auditEntry.runId = approval.runId;
      auditEntry.stageId = approval.stageId;
      auditEntry.pipelineName = approval.pipelineName;
      auditEntry.stageName = approval.stageName;
      auditEntry.decision = input.decision;
      auditEntry.approvedBy = input.approvedBy;
      auditEntry.comment = input.comment;

      // 2. Check authorization
      if (input.approvedBy) {
        const canApprove = this.deps.approvalQueue.canUserApprove(input.approvalId, input.approvedBy);
        if (!canApprove) {
          throw new ApprovalHandlerError(
            `User ${input.approvedBy} is not authorized to ${input.decision} this approval`,
            "UNAUTHORIZED"
          );
        }
      }

      // 3. Get the pipeline run and provider
      const run = this.deps.stateMachine.getRun(approval.runId);
      if (!run) {
        throw new ApprovalHandlerError(
          `Pipeline run not found: ${approval.runId}`,
          "NOT_FOUND"
        );
      }

      auditEntry.provider = run.provider;

      // 4. Get the stage
      const stage = this.deps.stateMachine.getStage(approval.runId, approval.stageId);
      if (!stage) {
        throw new ApprovalHandlerError(
          `Stage not found: ${approval.stageId}`,
          "NOT_FOUND"
        );
      }

      // 5. Notify the provider (if available)
      const provider = this.deps.getProvider(run.provider);
      let providerNotified = false;
      let providerError: string | undefined;

      if (provider) {
        try {
          await this.notifyProvider(provider, approval, input);
          providerNotified = true;
        } catch (error) {
          providerError = error instanceof Error ? error.message : String(error);

          // Emit provider notification failure event
          await this.emit("provider.notification_failed", {
            approval,
            error: error instanceof Error ? error : new Error(String(error)),
            provider: run.provider,
          });

          // If provider confirmation is required, throw the error
          if (this.config.requireProviderConfirmation) {
            throw new ApprovalHandlerError(
              `Failed to notify provider: ${providerError}`,
              "PROVIDER_ERROR"
            );
          }
        }
      }

      auditEntry.providerNotified = providerNotified;
      auditEntry.providerError = providerError;

      // 6. Complete the approval in the queue
      const decision = input.decision === "approve" ? "approved" : "rejected";
      const response = await this.deps.approvalQueue.completeApproval(
        input.approvalId,
        decision,
        {
          comment: input.comment,
          approvedBy: input.approvedBy,
        }
      );

      // 7. Update the state machine
      const targetState = input.decision === "approve" ? "approved" : "rejected";
      try {
        await this.deps.stateMachine.transitionStage(
          approval.runId,
          approval.stageId,
          targetState,
          {
            approvalResponse: response,
            result: input.decision === "approve" ? undefined : "failed",
          }
        );
        auditEntry.stateUpdated = true;

        // If rejected, skip remaining stages and fail the pipeline
        if (input.decision === "reject") {
          await this.deps.stateMachine.skipRemainingStages(approval.runId, approval.stageId);
          await this.deps.stateMachine.transitionPipeline(approval.runId, "failed");
        }
      } catch (error) {
        auditEntry.stateUpdated = false;
        throw new ApprovalHandlerError(
          `Failed to update state machine: ${error instanceof Error ? error.message : String(error)}`,
          "STATE_ERROR"
        );
      }

      // 8. Update the store (if available)
      if (this.deps.store) {
        try {
          const updatedRun = this.deps.stateMachine.getRun(approval.runId);
          if (updatedRun) {
            await this.deps.store.saveRun(updatedRun);
            auditEntry.storeUpdated = true;
          }
        } catch {
          // Store update failure is non-fatal
          auditEntry.storeUpdated = false;
        }
      }

      // 9. Finalize audit entry
      auditEntry.durationMs = Date.now() - startTime;
      this.addAuditEntry(auditEntry);

      // 10. Build result
      const updatedRun = this.deps.stateMachine.getRun(approval.runId);
      const updatedStage = this.deps.stateMachine.getStage(approval.runId, approval.stageId);

      const result: HandleApprovalResult = {
        success: true,
        approval,
        response,
        run: updatedRun,
        stage: updatedStage,
        auditEntry,
      };

      // 11. Emit decision processed event
      await this.emit("decision.processed", result);

      return result;
    } catch (error) {
      // Finalize audit entry on error
      auditEntry.durationMs = Date.now() - startTime;
      this.addAuditEntry(auditEntry);

      // Emit error event
      await this.emit("error", {
        approvalId: input.approvalId,
        error: error instanceof Error ? error : new Error(String(error)),
        context: "handleApproval",
      });

      if (error instanceof ApprovalHandlerError) {
        throw error;
      }

      throw new ApprovalHandlerError(
        `Failed to handle approval: ${error instanceof Error ? error.message : String(error)}`,
        "VALIDATION_ERROR"
      );
    }
  }

  /**
   * Handle approval (convenience method)
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
   * Handle rejection (convenience method)
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

  // ---------------------------------------------------------------------------
  // Provider Notification
  // ---------------------------------------------------------------------------

  /**
   * Notify the provider of the approval decision
   */
  private async notifyProvider(
    provider: PipelineProvider,
    approval: ApprovalRequest,
    input: HandleApprovalInput
  ): Promise<void> {
    const providerApprovalId = approval.providerApprovalId;

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new ApprovalHandlerError("Provider notification timed out", "TIMEOUT"));
      }, this.config.providerTimeoutMs);
    });

    // Build the API call based on decision
    const apiCall = async (): Promise<void> => {
      if (input.decision === "approve") {
        await provider.approveStage({
          runId: approval.runId,
          providerRunId: approval.providerRunId,
          approvalId: approval.id,
          providerApprovalId,
          comment: input.comment,
        });
      } else {
        await provider.rejectStage({
          runId: approval.runId,
          providerRunId: approval.providerRunId,
          approvalId: approval.id,
          providerApprovalId,
          comment: input.comment,
        });
      }
    };

    // Retry logic
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Race between the API call and timeout
        await Promise.race([apiCall(), timeoutPromise]);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on timeout or if it's the last attempt
        if (
          error instanceof ApprovalHandlerError && error.code === "TIMEOUT" ||
          attempt === this.config.maxRetries
        ) {
          break;
        }

        // Wait before retry (exponential backoff)
        await this.delay(Math.pow(2, attempt) * 1000);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  // ---------------------------------------------------------------------------
  // Audit Log
  // ---------------------------------------------------------------------------

  /**
   * Get all audit log entries
   */
  getAuditLog(): ApprovalAuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Get audit log entries for a specific run
   */
  getAuditLogByRun(runId: string): ApprovalAuditEntry[] {
    return this.auditLog.filter((entry) => entry.runId === runId);
  }

  /**
   * Get audit log entries for a specific approval
   */
  getAuditLogByApproval(approvalId: ApprovalId): ApprovalAuditEntry[] {
    return this.auditLog.filter((entry) => entry.approvalId === approvalId);
  }

  /**
   * Clear the audit log
   */
  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  /**
   * Get audit log statistics
   */
  getAuditStats(): {
    totalEntries: number;
    approveCount: number;
    rejectCount: number;
    providerFailureCount: number;
    averageDurationMs: number;
  } {
    let approveCount = 0;
    let rejectCount = 0;
    let providerFailureCount = 0;
    let totalDuration = 0;

    for (const entry of this.auditLog) {
      if (entry.decision === "approve") {
        approveCount++;
      } else {
        rejectCount++;
      }
      if (entry.providerError) {
        providerFailureCount++;
      }
      totalDuration += entry.durationMs;
    }

    return {
      totalEntries: this.auditLog.length,
      approveCount,
      rejectCount,
      providerFailureCount,
      averageDurationMs: this.auditLog.length > 0 ? totalDuration / this.auditLog.length : 0,
    };
  }

  private createAuditEntry(approvalId: ApprovalId): ApprovalAuditEntry {
    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      approvalId,
      runId: "",
      stageId: "",
      pipelineName: "",
      stageName: "",
      decision: "approve",
      providerNotified: false,
      stateUpdated: false,
      storeUpdated: false,
      durationMs: 0,
    };
  }

  private addAuditEntry(entry: ApprovalAuditEntry): void {
    if (!this.config.enableAuditLog) {
      return;
    }

    this.auditLog.push(entry);

    // Trim audit log if it exceeds max size
    while (this.auditLog.length > this.config.maxAuditLogSize) {
      this.auditLog.shift();
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new ApprovalHandlerError(
        "ApprovalHandler not initialized. Call initialize() first.",
        "NOT_INITIALIZED"
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the handler configuration
   */
  getConfig(): Required<ApprovalHandlerConfig> {
    return { ...this.config };
  }
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new approval handler instance
 *
 * @param deps - Handler dependencies
 * @param config - Optional configuration
 * @returns Uninitialized handler instance (call initialize() before use)
 */
export function createApprovalHandler(
  deps: ApprovalHandlerDependencies,
  config?: ApprovalHandlerConfig
): ApprovalHandler {
  return new ApprovalHandler(deps, config);
}

/**
 * Create and initialize an approval handler
 *
 * @param deps - Handler dependencies
 * @param config - Optional configuration
 * @returns Initialized handler instance
 */
export async function createAndInitializeApprovalHandler(
  deps: ApprovalHandlerDependencies,
  config?: ApprovalHandlerConfig
): Promise<ApprovalHandler> {
  const handler = createApprovalHandler(deps, config);
  await handler.initialize();
  return handler;
}
