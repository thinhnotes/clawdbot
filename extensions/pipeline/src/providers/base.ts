/**
 * Pipeline Provider Base Interface
 *
 * Abstract base interface for pipeline providers (Azure DevOps, GitHub Actions, GitLab CI).
 * Each provider implements this interface to provide a consistent API for the pipeline manager.
 *
 * Responsibilities:
 * - Webhook verification and event parsing
 * - Pipeline triggering and status monitoring
 * - Stage approval/rejection for approval gates
 * - Build log retrieval
 * - Pipeline listing and history queries
 */

import type {
  ApproveStageInput,
  CancelPipelineInput,
  GetLogsInput,
  GetLogsResult,
  GetPipelineHistoryInput,
  GetPipelineHistoryResult,
  GetPipelineStatusInput,
  ListPipelinesResult,
  PipelineRun,
  ProviderName,
  RejectStageInput,
  Stage,
  StageId,
  TriggerPipelineInput,
  TriggerPipelineResult,
  WebhookContext,
  WebhookParseResult,
  WebhookVerificationResult,
} from "../types.js";

// -----------------------------------------------------------------------------
// Provider Configuration Types
// -----------------------------------------------------------------------------

/**
 * Base configuration shared by all providers
 */
export interface BaseProviderConfig {
  /** Polling interval in milliseconds for status updates (if not using webhooks) */
  pollingIntervalMs?: number;
  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
}

/**
 * Azure DevOps provider configuration
 */
export interface AzureDevOpsProviderConfig extends BaseProviderConfig {
  /** Azure DevOps organization URL (e.g., https://dev.azure.com/myorg) */
  organizationUrl: string;
  /** Azure DevOps project name */
  project: string;
  /** Personal Access Token for authentication */
  pat: string;
  /** Optional webhook secret for signature verification */
  webhookSecret?: string;
}

/**
 * GitHub Actions provider configuration
 */
export interface GitHubActionsProviderConfig extends BaseProviderConfig {
  /** GitHub repository owner */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** GitHub personal access token or app installation token */
  token: string;
  /** Optional webhook secret for signature verification */
  webhookSecret?: string;
}

/**
 * GitLab CI provider configuration
 */
export interface GitLabCIProviderConfig extends BaseProviderConfig {
  /** GitLab instance URL (e.g., https://gitlab.com) */
  baseUrl: string;
  /** GitLab project ID or path */
  projectId: string | number;
  /** GitLab personal access token or project token */
  token: string;
  /** Optional webhook secret for signature verification */
  webhookSecret?: string;
}

/**
 * Mock provider configuration (for testing)
 */
export interface MockProviderConfig extends BaseProviderConfig {
  /** Simulated delay for API calls in milliseconds */
  simulatedDelayMs?: number;
  /** Number of stages to simulate */
  stageCount?: number;
  /** Whether to simulate approval gates */
  simulateApprovalGates?: boolean;
  /** Failure probability (0-1) for simulating failures */
  failureProbability?: number;
}

/**
 * Provider configuration discriminated union
 */
export type ProviderConfig =
  | { type: "azure-devops"; config: AzureDevOpsProviderConfig }
  | { type: "github-actions"; config: GitHubActionsProviderConfig }
  | { type: "gitlab-ci"; config: GitLabCIProviderConfig }
  | { type: "mock"; config: MockProviderConfig };

// -----------------------------------------------------------------------------
// Provider Error Types
// -----------------------------------------------------------------------------

/**
 * Error codes for provider operations
 */
export type ProviderErrorCode =
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "PERMISSION_DENIED"
  | "APPROVAL_EXPIRED"
  | "ALREADY_APPROVED"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

/**
 * Structured error from provider operations
 */
export class PipelineProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly provider: ProviderName,
    public readonly cause?: Error,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PipelineProviderError";
  }
}

// -----------------------------------------------------------------------------
// Provider Interface
// -----------------------------------------------------------------------------

/**
 * Abstract base interface for pipeline providers.
 *
 * Each provider (Azure DevOps, GitHub Actions, GitLab CI, Mock) implements this
 * interface to provide a consistent API for the pipeline manager.
 *
 * @example
 * ```typescript
 * const provider: PipelineProvider = new AzureDevOpsProvider(config);
 *
 * // Trigger a pipeline
 * const result = await provider.triggerPipeline({
 *   pipelineId: "my-pipeline",
 *   branch: "main",
 * });
 *
 * // Monitor status
 * const run = await provider.getPipelineStatus({
 *   runId: result.runId,
 *   providerRunId: result.providerRunId,
 * });
 * ```
 */
export interface PipelineProvider {
  /** Provider identifier (e.g., "azure-devops", "github-actions") */
  readonly name: ProviderName;

  // ---------------------------------------------------------------------------
  // Webhook Handling
  // ---------------------------------------------------------------------------

  /**
   * Verify webhook signature/HMAC before processing.
   * Must be called before parseWebhookEvent to ensure request authenticity.
   *
   * @param ctx - Webhook context containing headers and raw body
   * @returns Verification result with success status and optional error reason
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  /**
   * Parse provider-specific webhook payload into normalized events.
   * Converts provider-specific webhook format into standard ProviderEvent types.
   *
   * @param ctx - Webhook context containing parsed body and headers
   * @returns Parsed events and optional response for the provider
   */
  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult;

  // ---------------------------------------------------------------------------
  // Pipeline Operations
  // ---------------------------------------------------------------------------

  /**
   * Trigger a new pipeline run.
   *
   * @param input - Pipeline trigger parameters (pipelineId, branch, parameters)
   * @returns Result containing run IDs and initial status
   * @throws PipelineProviderError if pipeline cannot be triggered
   */
  triggerPipeline(input: TriggerPipelineInput): Promise<TriggerPipelineResult>;

  /**
   * Get the current status of a pipeline run.
   *
   * @param input - Run identification (runId and/or providerRunId)
   * @returns Full pipeline run details including all stages
   * @throws PipelineProviderError if run not found or cannot be fetched
   */
  getPipelineStatus(input: GetPipelineStatusInput): Promise<PipelineRun>;

  /**
   * Get the status of a specific stage within a pipeline run.
   *
   * @param input - Run identification
   * @param stageId - Stage identifier to fetch
   * @returns Stage details or null if stage not found
   * @throws PipelineProviderError if run not found or cannot be fetched
   */
  getStageStatus(input: GetPipelineStatusInput, stageId: StageId): Promise<Stage | null>;

  /**
   * Cancel an in-progress pipeline run.
   *
   * @param input - Run identification to cancel
   * @throws PipelineProviderError if run cannot be cancelled
   */
  cancelPipeline(input: CancelPipelineInput): Promise<void>;

  // ---------------------------------------------------------------------------
  // Approval Operations
  // ---------------------------------------------------------------------------

  /**
   * Approve a pending approval gate, allowing the pipeline to continue.
   *
   * @param input - Approval details including approvalId and optional comment
   * @throws PipelineProviderError if approval fails (expired, already processed, etc.)
   */
  approveStage(input: ApproveStageInput): Promise<void>;

  /**
   * Reject a pending approval gate, stopping the pipeline at this stage.
   *
   * @param input - Rejection details including approvalId and optional comment
   * @throws PipelineProviderError if rejection fails
   */
  rejectStage(input: RejectStageInput): Promise<void>;

  // ---------------------------------------------------------------------------
  // Log Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Fetch build logs for a pipeline run, optionally filtered by stage/job.
   *
   * @param input - Log query parameters (runId, optional stageId/jobId)
   * @returns Log entries with optional pagination info
   * @throws PipelineProviderError if logs cannot be fetched
   */
  getLogs(input: GetLogsInput): Promise<GetLogsResult>;

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  /**
   * List all available pipeline definitions.
   *
   * @returns List of pipeline definitions available in the project
   * @throws PipelineProviderError if listing fails
   */
  listPipelines(): Promise<ListPipelinesResult>;

  /**
   * Get historical runs for a pipeline or project.
   *
   * @param input - Query parameters (pipelineId, limit, state filter, time range)
   * @returns List of pipeline runs with optional pagination
   * @throws PipelineProviderError if history cannot be fetched
   */
  getPipelineHistory(input: GetPipelineHistoryInput): Promise<GetPipelineHistoryResult>;

  // ---------------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------------

  /**
   * Initialize the provider (e.g., verify credentials, establish connections).
   * Called once when the provider is created.
   *
   * @throws PipelineProviderError if initialization fails
   */
  initialize?(): Promise<void>;

  /**
   * Clean up provider resources.
   * Called when the provider is being disposed.
   */
  dispose?(): Promise<void>;
}

// -----------------------------------------------------------------------------
// Helper Types
// -----------------------------------------------------------------------------

/**
 * Options for polling pipeline status
 */
export interface PollStatusOptions {
  /** Polling interval in milliseconds (default: 5000) */
  intervalMs?: number;
  /** Maximum time to wait in milliseconds (default: 3600000 - 1 hour) */
  timeoutMs?: number;
  /** Callback invoked on each poll with current status */
  onUpdate?: (run: PipelineRun) => void;
  /** AbortSignal to cancel polling */
  signal?: AbortSignal;
}

/**
 * Result of polling for pipeline completion
 */
export interface PollStatusResult {
  /** Final pipeline run state */
  run: PipelineRun;
  /** Whether polling completed (vs. timed out or cancelled) */
  completed: boolean;
  /** Reason if not completed */
  reason?: "timeout" | "cancelled";
}

/**
 * Utility function signature for polling pipeline status until completion
 */
export type PollPipelineStatusFn = (
  provider: PipelineProvider,
  input: GetPipelineStatusInput,
  options?: PollStatusOptions
) => Promise<PollStatusResult>;
