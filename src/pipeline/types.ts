/**
 * Pipeline Stage Status
 * Represents all possible states a stage can be in during pipeline execution.
 */
export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

/**
 * Pipeline Status
 * Represents the overall status of a pipeline.
 */
export type PipelineStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Approval Request Status
 * Represents the status of an approval request.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * Stage Executor Type
 * Defines the type of executor that runs the stage.
 */
export type StageExecutorType = "azdo" | "script" | "manual";

/**
 * Stage Executor Configuration
 * Configuration for how a stage is executed.
 */
export type StageExecutor =
  | { kind: "azdo"; organization: string; project: string; pipelineId: string }
  | { kind: "script"; command: string; workingDir?: string; timeout?: number }
  | { kind: "manual"; instructions?: string };

/**
 * Approval Configuration
 * Configuration for stage approval requirements.
 */
export type ApprovalConfig = {
  required: boolean;
  approvers?: string[];
  timeoutMs?: number;
  autoApprove?: boolean;
  autoReject?: boolean;
};

/**
 * Stage State
 * Runtime state tracking for a stage.
 */
export type StageState = {
  startedAtMs?: number;
  completedAtMs?: number;
  error?: string;
  output?: string;
  executorRunId?: string;
};

/**
 * Stage
 * Represents a single stage in a pipeline.
 */
export type Stage = {
  id: string;
  name: string;
  description?: string;
  status: StageStatus;
  order: number;
  dependencies: string[];
  executor: StageExecutor;
  approvalConfig: ApprovalConfig;
  state: StageState;
};

/**
 * Pipeline
 * Represents a complete pipeline with multiple stages.
 */
export type Pipeline = {
  id: string;
  name: string;
  description?: string;
  status: PipelineStatus;
  createdAtMs: number;
  updatedAtMs: number;
  stages: Stage[];
  currentStageId?: string;
  config: PipelineConfig;
};

/**
 * Pipeline Configuration
 * Global configuration options for a pipeline.
 */
export type PipelineConfig = {
  /** Whether to stop the pipeline on first stage failure */
  stopOnFailure: boolean;
  /** Notification channels for pipeline events */
  notificationChannels?: string[];
  /** Default timeout for stages in milliseconds */
  defaultTimeoutMs?: number;
  /** Default approval configuration */
  defaultApprovalConfig?: ApprovalConfig;
  /** Metadata for tracking */
  metadata?: Record<string, string>;
};

/**
 * Approval Request
 * Represents a pending approval request for a stage.
 */
export type ApprovalRequest = {
  id: string;
  pipelineId: string;
  stageId: string;
  status: ApprovalStatus;
  requestedAtMs: number;
  requestedBy?: string;
  expiresAtMs?: number;
  processedAtMs?: number;
  processedBy?: string;
  comment?: string;
};

/**
 * Stage Create
 * Input type for creating a new stage.
 */
export type StageCreate = Omit<Stage, "status" | "state"> & {
  status?: StageStatus;
  state?: Partial<StageState>;
};

/**
 * Stage Patch
 * Input type for updating an existing stage.
 */
export type StagePatch = Partial<Omit<Stage, "id">>;

/**
 * Pipeline Create
 * Input type for creating a new pipeline.
 */
export type PipelineCreate = Omit<
  Pipeline,
  "id" | "createdAtMs" | "updatedAtMs" | "status" | "currentStageId"
> & {
  status?: PipelineStatus;
  stages: StageCreate[];
};

/**
 * Pipeline Patch
 * Input type for updating an existing pipeline.
 */
export type PipelinePatch = Partial<
  Omit<Pipeline, "id" | "createdAtMs" | "stages">
> & {
  stages?: StagePatch[];
};

/**
 * Pipeline Store File
 * File format for persisting pipelines to disk.
 */
export type PipelineStoreFile = {
  version: 1;
  pipelines: Pipeline[];
  approvalRequests: ApprovalRequest[];
};

/**
 * Stage Transition
 * Represents a state machine transition event for a stage.
 */
export type StageTransition = {
  pipelineId: string;
  stageId: string;
  fromStatus: StageStatus;
  toStatus: StageStatus;
  timestamp: number;
  triggeredBy?: string;
  reason?: string;
};

/**
 * Valid Stage Transitions
 * Map defining valid state transitions for stages.
 */
export const VALID_STAGE_TRANSITIONS: Record<StageStatus, StageStatus[]> = {
  pending: ["running"],
  running: ["awaiting_approval", "completed", "failed"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["running", "completed"],
  rejected: ["pending"],
  completed: [],
  failed: ["pending"],
};

/**
 * Checks if a stage transition is valid.
 */
export function isValidStageTransition(
  from: StageStatus,
  to: StageStatus
): boolean {
  return VALID_STAGE_TRANSITIONS[from].includes(to);
}
