import type { ApprovalEvent, ApprovalNotification } from "./approval-types.js";
import type { Pipeline, PipelineStoreFile, StageTransition } from "./types.js";

/**
 * Pipeline Event
 * Represents lifecycle events for pipelines and their stages.
 */
export type PipelineEvent =
  | {
      kind: "pipeline_created";
      pipelineId: string;
      name: string;
    }
  | {
      kind: "pipeline_started";
      pipelineId: string;
      name: string;
    }
  | {
      kind: "pipeline_completed";
      pipelineId: string;
      name: string;
      success: boolean;
    }
  | {
      kind: "pipeline_cancelled";
      pipelineId: string;
      name: string;
      reason?: string;
    }
  | {
      kind: "stage_started";
      pipelineId: string;
      stageId: string;
      stageName: string;
    }
  | {
      kind: "stage_completed";
      pipelineId: string;
      stageId: string;
      stageName: string;
      success: boolean;
      error?: string;
    }
  | {
      kind: "stage_transitioned";
      transition: StageTransition;
    }
  | {
      kind: "approval_event";
      event: ApprovalEvent;
    };

/**
 * Logger Interface
 * Matches the existing logger pattern used in CronService.
 */
export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Notification Handler
 * Function to send notifications through configured channels.
 */
export type NotificationHandler = (
  notification: ApprovalNotification
) => Promise<boolean>;

/**
 * Stage Executor Handler
 * Function to execute a pipeline stage and return the result.
 */
export type StageExecutorHandler = (params: {
  pipeline: Pipeline;
  stageId: string;
}) => Promise<{
  status: "completed" | "failed" | "awaiting_approval";
  output?: string;
  error?: string;
  executorRunId?: string;
}>;

/**
 * Pipeline Service Dependencies
 * External dependencies required by the pipeline service.
 */
export type PipelineServiceDeps = {
  /** Function to get current time in ms (defaults to Date.now) */
  nowMs?: () => number;
  /** Logger instance */
  log: Logger;
  /** Path to the pipeline store JSON file */
  storePath: string;
  /** Whether the pipeline service is enabled */
  pipelineEnabled: boolean;
  /** Handler for sending notifications */
  sendNotification?: NotificationHandler;
  /** Handler for executing stages */
  executeStage?: StageExecutorHandler;
  /** Callback for pipeline events */
  onEvent?: (event: PipelineEvent) => void;
  /** Enqueue a system event for the agent */
  enqueueSystemEvent?: (text: string, opts?: { agentId?: string }) => void;
};

/**
 * Pipeline Service Dependencies (Internal)
 * Internal version with required nowMs function.
 */
export type PipelineServiceDepsInternal = Omit<PipelineServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

/**
 * Pipeline Service State
 * Internal state for the pipeline service.
 */
export type PipelineServiceState = {
  /** Resolved dependencies */
  deps: PipelineServiceDepsInternal;
  /** Loaded store data (null if not loaded) */
  store: PipelineStoreFile | null;
  /** Polling timer for stage execution monitoring */
  timer: NodeJS.Timeout | null;
  /** Whether the service is currently running */
  running: boolean;
  /** Promise chain for serializing operations */
  op: Promise<unknown>;
  /** Whether we've warned about being disabled */
  warnedDisabled: boolean;
  /** Map of active stage execution promises by pipelineId:stageId */
  activeExecutions: Map<string, Promise<void>>;
};

/**
 * Creates the initial state for the pipeline service.
 * @param deps - The service dependencies
 * @returns The initial service state
 */
export function createPipelineServiceState(
  deps: PipelineServiceDeps
): PipelineServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    activeExecutions: new Map(),
  };
}

/**
 * Pipeline Run Mode
 * How to run stages - force ignores approval requirements.
 */
export type PipelineRunMode = "normal" | "force";

/**
 * Pipeline Status Summary
 * Summary of the current pipeline service status.
 */
export type PipelineStatusSummary = {
  /** Whether the service is enabled */
  enabled: boolean;
  /** Path to the store file */
  storePath: string;
  /** Number of configured pipelines */
  pipelineCount: number;
  /** Number of currently running pipelines */
  runningCount: number;
  /** Number of pending approval requests */
  pendingApprovalCount: number;
};

/**
 * Pipeline Operation Result
 * Generic result type for pipeline operations.
 */
export type PipelineOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Pipeline Create Result
 * Result of creating a new pipeline.
 */
export type PipelineCreateResult = PipelineOperationResult<Pipeline>;

/**
 * Pipeline Start Result
 * Result of starting a pipeline.
 */
export type PipelineStartResult = PipelineOperationResult<{
  pipeline: Pipeline;
  startedStageId: string;
}>;

/**
 * Pipeline Advance Result
 * Result of advancing to the next stage.
 */
export type PipelineAdvanceResult = PipelineOperationResult<{
  pipeline: Pipeline;
  previousStageId: string;
  nextStageId: string | null;
}>;

/**
 * Approval Process Result
 * Result of processing an approval action.
 */
export type ApprovalProcessResult = PipelineOperationResult<{
  pipelineId: string;
  stageId: string;
  action: "approve" | "reject";
  processedBy: string;
}>;

/**
 * Pipeline List Result
 * Result of listing pipelines.
 */
export type PipelineListResult = Pipeline[];

/**
 * Pipeline Get Result
 * Result of getting a single pipeline.
 */
export type PipelineGetResult = Pipeline | null;
