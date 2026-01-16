/**
 * Azure DevOps Stage Executor
 * Connects Azure DevOps builds as pipeline stages, handling triggering,
 * polling, and status mapping.
 */

import type { Pipeline, Stage, StageState } from "./types.js";
import type { Logger } from "./state.js";
import {
  type AzDoConfig,
  type AzDoPipelineRun,
  type WaitForBuildOptions,
  triggerBuild,
  getBuildStatus,
  waitForBuild,
  mapRunToStageStatus,
  isRunSuccessful,
  cancelBuild,
} from "./azdo-cli.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for an Azure DevOps stage executor
 */
export type AzDoStageConfig = {
  /** Azure DevOps organization URL */
  organization: string;
  /** Azure DevOps project name */
  project: string;
  /** Pipeline ID or name */
  pipelineId: string;
  /** Branch to build (optional, defaults to default branch) */
  branch?: string;
  /** Variables to pass to the pipeline */
  variables?: Record<string, string>;
  /** Timeout for the build in milliseconds (default: 1 hour) */
  timeoutMs?: number;
  /** Polling interval in milliseconds (default: 30 seconds) */
  pollIntervalMs?: number;
};

/**
 * Result of executing an Azure DevOps stage
 */
export type AzDoStageResult = {
  /** Final status of the stage */
  status: "completed" | "failed" | "awaiting_approval";
  /** Output message from the execution */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Azure DevOps run ID */
  executorRunId?: string;
  /** Final Azure DevOps run state */
  run?: AzDoPipelineRun;
};

/**
 * Options for stage execution
 */
export type ExecuteStageOptions = {
  /** Logger for execution messages */
  log?: Logger;
  /** Callback for status updates */
  onStatusChange?: (run: AzDoPipelineRun, stage: Stage) => void;
  /** Cancellation signal */
  signal?: AbortSignal;
};

/**
 * Active execution tracking
 */
export type ActiveExecution = {
  pipelineId: string;
  stageId: string;
  runId: number;
  startedAt: number;
  config: AzDoConfig;
};

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for Azure DevOps builds (1 hour) */
const DEFAULT_BUILD_TIMEOUT_MS = 3_600_000;

/** Default polling interval (30 seconds) */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// =============================================================================
// AzDoStageExecutor Class
// =============================================================================

/**
 * AzDoStageExecutor
 * Executes pipeline stages by triggering and monitoring Azure DevOps builds.
 *
 * Features:
 * - Triggers Azure DevOps pipeline runs
 * - Polls build status until completion
 * - Maps Azure DevOps build states to pipeline stage states
 * - Handles timeouts and cancellation
 * - Supports variables and branch selection
 */
export class AzDoStageExecutor {
  private readonly log: Logger;
  private activeExecutions: Map<string, ActiveExecution> = new Map();

  constructor(log: Logger) {
    this.log = log;
  }

  /**
   * Extracts Azure DevOps configuration from a stage's executor config.
   * @param stage - The stage to extract config from
   * @returns Azure DevOps config or null if not an azdo stage
   */
  extractConfig(stage: Stage): AzDoStageConfig | null {
    if (stage.executor.kind !== "azdo") {
      return null;
    }

    return {
      organization: stage.executor.organization,
      project: stage.executor.project,
      pipelineId: stage.executor.pipelineId,
    };
  }

  /**
   * Executes an Azure DevOps stage by triggering a build and waiting for completion.
   *
   * @param pipeline - The pipeline containing the stage
   * @param stage - The stage to execute
   * @param opts - Execution options
   * @returns Stage execution result
   */
  async execute(
    pipeline: Pipeline,
    stage: Stage,
    opts?: ExecuteStageOptions
  ): Promise<AzDoStageResult> {
    const config = this.extractConfig(stage);
    if (!config) {
      return {
        status: "failed",
        error: `Stage ${stage.id} is not an Azure DevOps stage`,
      };
    }

    const executionKey = `${pipeline.id}:${stage.id}`;
    const log = opts?.log ?? this.log;

    log.info(
      {
        pipelineId: pipeline.id,
        stageId: stage.id,
        organization: config.organization,
        project: config.project,
        azdoPipelineId: config.pipelineId,
      },
      "azdo-stage: triggering build"
    );

    // Trigger the Azure DevOps build
    const azDoConfig: AzDoConfig = {
      organization: config.organization,
      project: config.project,
    };

    const triggerResult = await triggerBuild(azDoConfig, {
      pipelineId: parseInt(config.pipelineId, 10) || undefined,
      name: isNaN(parseInt(config.pipelineId, 10))
        ? config.pipelineId
        : undefined,
      branch: config.branch,
      variables: config.variables,
    });

    if (!triggerResult.ok) {
      log.error(
        { error: triggerResult.error, stageId: stage.id },
        "azdo-stage: failed to trigger build"
      );
      return {
        status: "failed",
        error: `Failed to trigger Azure DevOps build: ${triggerResult.error}`,
      };
    }

    const run = triggerResult.data;
    const runId = run.id;

    log.info(
      {
        runId,
        stageId: stage.id,
        status: run.status,
      },
      "azdo-stage: build triggered"
    );

    // Track the active execution
    this.activeExecutions.set(executionKey, {
      pipelineId: pipeline.id,
      stageId: stage.id,
      runId,
      startedAt: Date.now(),
      config: azDoConfig,
    });

    try {
      // Wait for the build to complete
      const waitOptions: WaitForBuildOptions = {
        pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        timeoutMs: config.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
        onStatusChange: (updatedRun) => {
          log.debug(
            {
              runId,
              stageId: stage.id,
              status: updatedRun.status,
              result: updatedRun.result,
            },
            "azdo-stage: status update"
          );
          opts?.onStatusChange?.(updatedRun, stage);
        },
      };

      const waitResult = await waitForBuild(azDoConfig, runId, waitOptions);

      if (!waitResult.ok) {
        log.error(
          { error: waitResult.error, runId, stageId: stage.id },
          "azdo-stage: error waiting for build"
        );
        return {
          status: "failed",
          error: `Error waiting for build: ${waitResult.error}`,
          executorRunId: String(runId),
        };
      }

      const { run: finalRun, timedOut } = waitResult.data;

      if (timedOut) {
        log.warn(
          { runId, stageId: stage.id, status: finalRun.status },
          "azdo-stage: build timed out"
        );
        return {
          status: "failed",
          error: `Build timed out after ${config.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS}ms`,
          executorRunId: String(runId),
          run: finalRun,
        };
      }

      // Map the final status
      const stageStatus = mapRunToStageStatus(finalRun);
      const success = isRunSuccessful(finalRun);

      log.info(
        {
          runId,
          stageId: stage.id,
          azDoStatus: finalRun.status,
          azDoResult: finalRun.result,
          stageStatus,
          success,
        },
        "azdo-stage: build completed"
      );

      if (success) {
        // Check if approval is required after successful build
        if (stage.approvalConfig?.required) {
          return {
            status: "awaiting_approval",
            output: `Azure DevOps build ${runId} succeeded. Awaiting approval.`,
            executorRunId: String(runId),
            run: finalRun,
          };
        }
        return {
          status: "completed",
          output: `Azure DevOps build ${runId} succeeded.`,
          executorRunId: String(runId),
          run: finalRun,
        };
      }

      return {
        status: "failed",
        error: `Azure DevOps build ${runId} failed with result: ${finalRun.result ?? "unknown"}`,
        executorRunId: String(runId),
        run: finalRun,
      };
    } finally {
      // Clean up active execution tracking
      this.activeExecutions.delete(executionKey);
    }
  }

  /**
   * Cancels an active Azure DevOps build for a stage.
   *
   * @param pipelineId - The pipeline ID
   * @param stageId - The stage ID
   * @returns True if cancelled, false if not found or already completed
   */
  async cancelExecution(pipelineId: string, stageId: string): Promise<boolean> {
    const executionKey = `${pipelineId}:${stageId}`;
    const execution = this.activeExecutions.get(executionKey);

    if (!execution) {
      this.log.debug(
        { pipelineId, stageId },
        "azdo-stage: no active execution to cancel"
      );
      return false;
    }

    this.log.info(
      { pipelineId, stageId, runId: execution.runId },
      "azdo-stage: cancelling build"
    );

    const result = await cancelBuild(execution.config, execution.runId);

    if (result.ok) {
      this.activeExecutions.delete(executionKey);
      this.log.info(
        { pipelineId, stageId, runId: execution.runId },
        "azdo-stage: build cancelled"
      );
      return true;
    }

    this.log.error(
      { pipelineId, stageId, runId: execution.runId, error: result.error },
      "azdo-stage: failed to cancel build"
    );
    return false;
  }

  /**
   * Gets the status of an active Azure DevOps build for a stage.
   *
   * @param pipelineId - The pipeline ID
   * @param stageId - The stage ID
   * @returns Current run status or null if not found
   */
  async getExecutionStatus(
    pipelineId: string,
    stageId: string
  ): Promise<AzDoPipelineRun | null> {
    const executionKey = `${pipelineId}:${stageId}`;
    const execution = this.activeExecutions.get(executionKey);

    if (!execution) {
      return null;
    }

    const result = await getBuildStatus(execution.config, execution.runId);

    if (!result.ok) {
      this.log.error(
        { pipelineId, stageId, runId: execution.runId, error: result.error },
        "azdo-stage: failed to get build status"
      );
      return null;
    }

    return result.data;
  }

  /**
   * Gets all active executions.
   */
  getActiveExecutions(): ActiveExecution[] {
    return Array.from(this.activeExecutions.values());
  }

  /**
   * Checks if a stage has an active execution.
   */
  hasActiveExecution(pipelineId: string, stageId: string): boolean {
    return this.activeExecutions.has(`${pipelineId}:${stageId}`);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Creates a new AzDoStageExecutor instance.
 * @param log - Logger instance
 * @returns New executor instance
 */
export function createAzDoStageExecutor(log: Logger): AzDoStageExecutor {
  return new AzDoStageExecutor(log);
}

// =============================================================================
// Stage Executor Handler Factory
// =============================================================================

/**
 * Creates a stage executor handler that uses AzDoStageExecutor for Azure DevOps stages.
 * This can be passed to PipelineServiceDeps.executeStage.
 *
 * @param executor - The AzDoStageExecutor instance
 * @param log - Logger instance
 * @returns Stage executor handler function
 */
export function createAzDoStageHandler(
  executor: AzDoStageExecutor,
  log: Logger
): (params: { pipeline: Pipeline; stageId: string }) => Promise<{
  status: "completed" | "failed" | "awaiting_approval";
  output?: string;
  error?: string;
  executorRunId?: string;
}> {
  return async ({ pipeline, stageId }) => {
    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) {
      return {
        status: "failed" as const,
        error: `Stage not found: ${stageId}`,
      };
    }

    // Only handle Azure DevOps stages
    if (stage.executor.kind !== "azdo") {
      log.debug(
        { stageId, executorKind: stage.executor.kind },
        "azdo-stage-handler: skipping non-azdo stage"
      );
      return {
        status: "failed" as const,
        error: `Stage ${stageId} is not an Azure DevOps stage (kind: ${stage.executor.kind})`,
      };
    }

    return executor.execute(pipeline, stage, { log });
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Maps Azure DevOps run status to stage state updates.
 * Useful for updating stage.state when polling.
 *
 * @param run - Azure DevOps pipeline run
 * @returns Partial stage state updates
 */
export function mapRunToStageState(run: AzDoPipelineRun): Partial<StageState> {
  const updates: Partial<StageState> = {
    executorRunId: String(run.id),
  };

  if (run.createdDate) {
    updates.startedAtMs = new Date(run.createdDate).getTime();
  }

  if (run.finishedDate) {
    updates.completedAtMs = new Date(run.finishedDate).getTime();
  }

  if (run.result === "failed" || run.result === "canceled") {
    updates.error = `Build ${run.result}`;
  }

  if (run.url) {
    updates.output = `Build URL: ${run.url}`;
  }

  return updates;
}

/**
 * Checks if a stage is configured as an Azure DevOps stage.
 */
export function isAzDoStage(stage: Stage): boolean {
  return stage.executor.kind === "azdo";
}

/**
 * Gets the Azure DevOps build URL for a run.
 */
export function getAzDoBuildUrl(
  config: AzDoStageConfig,
  runId: number
): string {
  // Azure DevOps build URLs follow this pattern:
  // https://dev.azure.com/{org}/{project}/_build/results?buildId={runId}
  return `${config.organization}/${config.project}/_build/results?buildId=${runId}`;
}
