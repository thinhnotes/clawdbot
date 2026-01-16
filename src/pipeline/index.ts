/**
 * Pipeline Module
 *
 * Multi-stage build pipeline system with manual approval gates.
 * Provides state machine for managing pipeline stages, Azure DevOps integration,
 * approval workflow with notifications, and commands for approve/reject/status.
 *
 * @module pipeline
 */

// =============================================================================
// Core Service
// =============================================================================

export { PipelineService } from "./service.js";
export type { PipelineEvent, PipelineServiceDeps } from "./service.js";

// =============================================================================
// Pipeline Types
// =============================================================================

export type {
  // Status enums
  StageStatus,
  PipelineStatus,
  ApprovalStatus,
  // Executor types
  StageExecutorType,
  StageExecutor,
  // Core entities
  Pipeline,
  Stage,
  StageState,
  ApprovalConfig,
  PipelineConfig,
  ApprovalRequest,
  // Store types
  PipelineStoreFile,
  StageTransition,
  // Input types
  StageCreate,
  StagePatch,
  PipelineCreate,
  PipelinePatch,
} from "./types.js";

export { VALID_STAGE_TRANSITIONS, isValidStageTransition } from "./types.js";

// =============================================================================
// State Types
// =============================================================================

export type {
  Logger,
  NotificationHandler,
  StageExecutorHandler,
  PipelineServiceState,
  PipelineRunMode,
  PipelineStatusSummary,
  PipelineOperationResult,
  PipelineCreateResult,
  PipelineStartResult,
  PipelineAdvanceResult,
  ApprovalProcessResult,
  PipelineListResult,
  PipelineGetResult,
} from "./state.js";

export { createPipelineServiceState } from "./state.js";

// =============================================================================
// Approval Types
// =============================================================================

export type {
  ApprovalAction,
  ApprovalResult,
  ApprovalQueue,
  ApprovalQueueEntry,
  ApprovalNotificationType,
  ApprovalNotificationChannel,
  ApprovalNotification,
  ApprovalNotificationAction,
  ApprovalEvent,
  ApprovalHandler,
  ApprovalProcessorInput,
  ApprovalTimeoutConfig,
  ApprovalHistoryEntry,
} from "./approval-types.js";

// =============================================================================
// Approval Queue Management
// =============================================================================

export type {
  ApprovalStats,
  TimeoutCheckResult,
  CheckTimeoutsResult,
  CheckTimeoutsOptions,
} from "./approval.js";

export {
  // Queue queries
  getApprovalQueue,
  getApprovalRequest,
  getPendingApprovalsForPipeline,
  isAwaitingApproval,
  // Queue operations
  requestApproval,
  processApprovalRequest,
  approve,
  reject,
  // Lookup
  findApprovalRequest,
  findApprovalQueueEntry,
  // History
  getApprovalHistory,
  getPipelineApprovalHistory,
  getStageApprovalHistory,
  getApprovalStats,
  // Cancellation
  cancelApprovalRequest,
  cancelAllPipelineApprovals,
  // Timeout handling
  checkTimeouts,
  getExpiringSoon,
  getNextExpiryTime,
  processTimeout,
} from "./approval.js";

// =============================================================================
// Approval Notifications
// =============================================================================

export type {
  NotificationDispatchResult,
  NotificationBroadcastResult,
  NotifyApprovalRequiredOptions,
  NotifyApprovalProcessedOptions,
  NotificationChannelConfig,
} from "./approval-notify.js";

export {
  notifyApprovalRequired,
  notifyApprovalProcessed,
  notifyApprovalTimeout,
  notifyApprovalReminder,
  notifyFromQueueEntry,
  resolveNotificationChannels,
  createConsoleNotificationHandler,
} from "./approval-notify.js";

// =============================================================================
// Configuration
// =============================================================================

export type {
  ResolvedPipelineConfig,
  ResolvedAzureDevOpsConfig,
  ResolvedApprovalDefaultsConfig,
} from "./config.js";

export {
  PIPELINE_DEFAULTS,
  AZDO_DEFAULTS,
  APPROVAL_DEFAULTS,
  resolvePipelineConfig,
  resolveAzureDevOpsConfig,
  resolveApprovalDefaultsConfig,
  resolvePipelineConfigFromClawdbot,
  isPipelineEnabled,
  getPipelineStorePath,
  validatePipelineConfig,
  createDefaultApprovalConfig,
  createAzDoExecutorConfig,
} from "./config.js";

// =============================================================================
// Azure DevOps CLI Integration
// =============================================================================

export type {
  AzDoConfig,
  AzDoRunStatus,
  AzDoRunResult,
  AzDoPipelineRun,
  AzDoPipelineDefinition,
  TriggerBuildOptions,
  ListBuildsOptions,
  WaitForBuildOptions,
  WaitResult,
  AzDoCliResult,
} from "./azdo-cli.js";

export {
  triggerBuild,
  getBuildStatus,
  listBuilds,
  waitForBuild,
  getPipeline,
  listPipelines,
  cancelBuild,
  checkAzDoCliAvailable,
  mapRunToStageStatus,
  isRunTerminal,
  isRunSuccessful,
} from "./azdo-cli.js";

// =============================================================================
// Azure DevOps Stage Executor
// =============================================================================

export type {
  AzDoStageConfig,
  AzDoStageResult,
  ExecuteStageOptions,
  ActiveExecution,
} from "./azdo-stage.js";

export {
  AzDoStageExecutor,
  createAzDoStageExecutor,
  createAzDoStageHandler,
  mapRunToStageState,
  isAzDoStage,
  getAzDoBuildUrl,
} from "./azdo-stage.js";

// =============================================================================
// Commands
// =============================================================================

// Re-export all command functionality
export * from "./commands/index.js";
