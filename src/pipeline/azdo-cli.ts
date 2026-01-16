/**
 * Azure DevOps CLI Wrapper
 * Provides typed wrapper functions for interacting with Azure DevOps pipelines
 * using the `az pipelines` CLI.
 */

import { runCommandWithTimeout } from "../process/exec.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Azure DevOps connection configuration
 */
export type AzDoConfig = {
  /** Azure DevOps organization URL (e.g., https://dev.azure.com/myorg) */
  organization: string;
  /** Azure DevOps project name */
  project: string;
};

/**
 * Run status values from Azure DevOps
 */
export type AzDoRunStatus =
  | "notStarted"
  | "inProgress"
  | "completed"
  | "canceling"
  | "postponed";

/**
 * Run result values from Azure DevOps
 */
export type AzDoRunResult =
  | "succeeded"
  | "failed"
  | "canceled"
  | "partiallySucceeded";

/**
 * Pipeline run information from Azure DevOps
 */
export type AzDoPipelineRun = {
  id: number;
  name: string;
  status: AzDoRunStatus;
  result?: AzDoRunResult;
  createdDate?: string;
  finishedDate?: string;
  url?: string;
  pipeline?: {
    id: number;
    name: string;
    folder?: string;
  };
  sourceBranch?: string;
  sourceVersion?: string;
};

/**
 * Pipeline definition from Azure DevOps
 */
export type AzDoPipelineDefinition = {
  id: number;
  name: string;
  folder?: string;
  revision?: number;
  url?: string;
};

/**
 * Options for triggering a build
 */
export type TriggerBuildOptions = {
  /** Pipeline name (mutually exclusive with pipelineId) */
  name?: string;
  /** Pipeline ID (mutually exclusive with name) */
  pipelineId?: number;
  /** Branch to build (e.g., refs/heads/main) */
  branch?: string;
  /** Variables to pass to the pipeline */
  variables?: Record<string, string>;
  /** Commit SHA to build */
  commit?: string;
};

/**
 * Options for listing builds
 */
export type ListBuildsOptions = {
  /** Filter by pipeline IDs */
  pipelineIds?: number[];
  /** Filter by status */
  status?: AzDoRunStatus;
  /** Filter by result */
  result?: AzDoRunResult;
  /** Filter by branch */
  branch?: string;
  /** Maximum number of results */
  top?: number;
};

/**
 * Options for waiting for a build
 */
export type WaitForBuildOptions = {
  /** Polling interval in milliseconds (default: 30000) */
  pollIntervalMs?: number;
  /** Timeout in milliseconds (default: 3600000 = 1 hour) */
  timeoutMs?: number;
  /** Callback for status updates */
  onStatusChange?: (run: AzDoPipelineRun) => void;
};

/**
 * Result of a CLI operation
 */
export type AzDoCliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: number };

/**
 * Wait result with final status
 */
export type WaitResult = {
  run: AzDoPipelineRun;
  timedOut: boolean;
};

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for CLI commands in milliseconds */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Default polling interval for waitForBuild in milliseconds */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Default timeout for waitForBuild in milliseconds (1 hour) */
const DEFAULT_WAIT_TIMEOUT_MS = 3_600_000;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Builds common CLI arguments for organization and project
 */
function buildBaseArgs(config: AzDoConfig): string[] {
  return [
    "--organization",
    config.organization,
    "--project",
    config.project,
    "--output",
    "json",
  ];
}

/**
 * Executes an Azure CLI command and returns the result
 */
async function executeAzCommand<T>(
  args: string[],
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<AzDoCliResult<T>> {
  try {
    const result = await runCommandWithTimeout(["az", ...args], { timeoutMs });

    if (result.code !== 0) {
      const errorMessage = result.stderr.trim() || result.stdout.trim() || "Command failed";
      return { ok: false, error: errorMessage, code: result.code ?? undefined };
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return { ok: false, error: "Empty response from CLI" };
    }

    try {
      const data = JSON.parse(stdout) as T;
      return { ok: true, data };
    } catch (parseError) {
      return { ok: false, error: `Failed to parse JSON response: ${stdout.slice(0, 200)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `CLI execution failed: ${message}` };
  }
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Triggers a new pipeline run in Azure DevOps.
 *
 * @param config - Azure DevOps connection configuration
 * @param options - Options for triggering the build
 * @returns Result containing the triggered run or error
 *
 * @example
 * ```typescript
 * const result = await triggerBuild(
 *   { organization: "https://dev.azure.com/myorg", project: "MyProject" },
 *   { name: "Build-Pipeline", branch: "refs/heads/main" }
 * );
 * if (result.ok) {
 *   console.log(`Started run ${result.data.id}`);
 * }
 * ```
 */
export async function triggerBuild(
  config: AzDoConfig,
  options: TriggerBuildOptions
): Promise<AzDoCliResult<AzDoPipelineRun>> {
  if (!options.name && options.pipelineId === undefined) {
    return { ok: false, error: "Either 'name' or 'pipelineId' must be provided" };
  }

  const args: string[] = ["pipelines", "run", ...buildBaseArgs(config)];

  if (options.name) {
    args.push("--name", options.name);
  } else if (options.pipelineId !== undefined) {
    args.push("--id", String(options.pipelineId));
  }

  if (options.branch) {
    args.push("--branch", options.branch);
  }

  if (options.commit) {
    args.push("--commit-id", options.commit);
  }

  if (options.variables && Object.keys(options.variables).length > 0) {
    // Format variables as key=value pairs
    const variableArgs = Object.entries(options.variables).map(
      ([key, value]) => `${key}=${value}`
    );
    args.push("--variables", ...variableArgs);
  }

  return executeAzCommand<AzDoPipelineRun>(args);
}

/**
 * Gets the status of a specific pipeline run.
 *
 * @param config - Azure DevOps connection configuration
 * @param runId - The run ID to check
 * @returns Result containing the run details or error
 *
 * @example
 * ```typescript
 * const result = await getBuildStatus(config, 12345);
 * if (result.ok) {
 *   console.log(`Status: ${result.data.status}, Result: ${result.data.result}`);
 * }
 * ```
 */
export async function getBuildStatus(
  config: AzDoConfig,
  runId: number
): Promise<AzDoCliResult<AzDoPipelineRun>> {
  const args: string[] = [
    "pipelines",
    "runs",
    "show",
    "--id",
    String(runId),
    ...buildBaseArgs(config),
  ];

  return executeAzCommand<AzDoPipelineRun>(args);
}

/**
 * Lists recent pipeline runs with optional filtering.
 *
 * @param config - Azure DevOps connection configuration
 * @param options - Options for filtering the list
 * @returns Result containing the list of runs or error
 *
 * @example
 * ```typescript
 * const result = await listBuilds(config, { status: "completed", top: 10 });
 * if (result.ok) {
 *   result.data.forEach(run => console.log(`${run.id}: ${run.result}`));
 * }
 * ```
 */
export async function listBuilds(
  config: AzDoConfig,
  options: ListBuildsOptions = {}
): Promise<AzDoCliResult<AzDoPipelineRun[]>> {
  const args: string[] = ["pipelines", "runs", "list", ...buildBaseArgs(config)];

  if (options.pipelineIds && options.pipelineIds.length > 0) {
    args.push("--pipeline-ids", options.pipelineIds.join(","));
  }

  if (options.status) {
    args.push("--status", options.status);
  }

  if (options.result) {
    args.push("--result", options.result);
  }

  if (options.branch) {
    args.push("--branch", options.branch);
  }

  if (options.top !== undefined) {
    args.push("--top", String(options.top));
  }

  return executeAzCommand<AzDoPipelineRun[]>(args);
}

/**
 * Gets pipeline definition by name or ID.
 *
 * @param config - Azure DevOps connection configuration
 * @param nameOrId - Pipeline name or ID
 * @returns Result containing the pipeline definition or error
 */
export async function getPipeline(
  config: AzDoConfig,
  nameOrId: string | number
): Promise<AzDoCliResult<AzDoPipelineDefinition>> {
  const args: string[] = ["pipelines", "show", ...buildBaseArgs(config)];

  if (typeof nameOrId === "number") {
    args.push("--id", String(nameOrId));
  } else {
    args.push("--name", nameOrId);
  }

  return executeAzCommand<AzDoPipelineDefinition>(args);
}

/**
 * Lists all pipeline definitions.
 *
 * @param config - Azure DevOps connection configuration
 * @returns Result containing the list of pipelines or error
 */
export async function listPipelines(
  config: AzDoConfig
): Promise<AzDoCliResult<AzDoPipelineDefinition[]>> {
  const args: string[] = ["pipelines", "list", ...buildBaseArgs(config)];

  return executeAzCommand<AzDoPipelineDefinition[]>(args);
}

/**
 * Waits for a pipeline run to complete with polling and timeout.
 *
 * @param config - Azure DevOps connection configuration
 * @param runId - The run ID to wait for
 * @param options - Options for waiting
 * @returns Result containing the final run state and whether it timed out
 *
 * @example
 * ```typescript
 * const result = await waitForBuild(config, runId, {
 *   timeoutMs: 300000, // 5 minutes
 *   pollIntervalMs: 10000, // 10 seconds
 *   onStatusChange: (run) => console.log(`Status: ${run.status}`),
 * });
 * if (result.ok) {
 *   if (result.data.timedOut) {
 *     console.log("Build did not complete in time");
 *   } else {
 *     console.log(`Build completed with result: ${result.data.run.result}`);
 *   }
 * }
 * ```
 */
export async function waitForBuild(
  config: AzDoConfig,
  runId: number,
  options: WaitForBuildOptions = {}
): Promise<AzDoCliResult<WaitResult>> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startTime = Date.now();

  let lastStatus: AzDoRunStatus | undefined;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      // Timeout - get final status and return
      const finalResult = await getBuildStatus(config, runId);
      if (finalResult.ok) {
        return { ok: true, data: { run: finalResult.data, timedOut: true } };
      }
      return { ok: false, error: `Timeout after ${elapsed}ms: ${finalResult.error}` };
    }

    const statusResult = await getBuildStatus(config, runId);
    if (!statusResult.ok) {
      return statusResult;
    }

    const run = statusResult.data;

    // Notify on status change
    if (run.status !== lastStatus) {
      lastStatus = run.status;
      options.onStatusChange?.(run);
    }

    // Check if completed
    if (run.status === "completed") {
      return { ok: true, data: { run, timedOut: false } };
    }

    // Check if cancelled or stuck
    if (run.status === "canceling") {
      // Wait a bit more and check if it moves to completed
      await sleep(pollIntervalMs);
      const cancelResult = await getBuildStatus(config, runId);
      if (cancelResult.ok && cancelResult.data.status === "completed") {
        return { ok: true, data: { run: cancelResult.data, timedOut: false } };
      }
      return { ok: true, data: { run: cancelResult.ok ? cancelResult.data : run, timedOut: false } };
    }

    // Wait before next poll
    await sleep(pollIntervalMs);
  }
}

/**
 * Cancels a running pipeline.
 *
 * @param config - Azure DevOps connection configuration
 * @param runId - The run ID to cancel
 * @returns Result indicating success or error
 */
export async function cancelBuild(
  config: AzDoConfig,
  runId: number
): Promise<AzDoCliResult<{ cancelled: boolean }>> {
  // Azure DevOps CLI doesn't have a direct cancel command for runs
  // We need to use the REST API via az devops invoke
  const args: string[] = [
    "devops",
    "invoke",
    "--area",
    "build",
    "--resource",
    "builds",
    "--route-parameters",
    `project=${config.project}`,
    `buildId=${runId}`,
    "--http-method",
    "PATCH",
    "--in-file",
    "-",
    "--organization",
    config.organization,
    "--output",
    "json",
  ];

  // The PATCH body to cancel the build
  const body = JSON.stringify({ status: "cancelling" });

  try {
    const result = await runCommandWithTimeout(["az", ...args], {
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      input: body,
    });

    if (result.code !== 0) {
      const errorMessage = result.stderr.trim() || result.stdout.trim() || "Cancel failed";
      return { ok: false, error: errorMessage, code: result.code ?? undefined };
    }

    return { ok: true, data: { cancelled: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to cancel build: ${message}` };
  }
}

/**
 * Checks if the Azure CLI and DevOps extension are available.
 *
 * @returns Result indicating availability or error message
 */
export async function checkAzDoCliAvailable(): Promise<AzDoCliResult<{ available: boolean; version?: string }>> {
  try {
    const result = await runCommandWithTimeout(["az", "--version"], {
      timeoutMs: 10_000,
    });

    if (result.code !== 0) {
      return { ok: false, error: "Azure CLI not available" };
    }

    const versionMatch = result.stdout.match(/azure-cli\s+(\d+\.\d+\.\d+)/);
    const version = versionMatch?.[1];

    // Check for devops extension
    const extResult = await runCommandWithTimeout(["az", "extension", "show", "--name", "azure-devops", "--output", "json"], {
      timeoutMs: 10_000,
    });

    if (extResult.code !== 0) {
      return { ok: false, error: "Azure DevOps extension not installed. Run: az extension add --name azure-devops" };
    }

    return { ok: true, data: { available: true, version } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to check Azure CLI: ${message}` };
  }
}

/**
 * Maps Azure DevOps run result to pipeline stage status.
 * Useful for integration with the pipeline service.
 *
 * @param run - The Azure DevOps run
 * @returns The corresponding stage status
 */
export function mapRunToStageStatus(
  run: AzDoPipelineRun
): "running" | "completed" | "failed" | "pending" {
  if (run.status === "completed") {
    switch (run.result) {
      case "succeeded":
      case "partiallySucceeded":
        return "completed";
      case "failed":
      case "canceled":
        return "failed";
      default:
        return "completed";
    }
  }

  if (run.status === "inProgress") {
    return "running";
  }

  if (run.status === "notStarted" || run.status === "postponed") {
    return "pending";
  }

  // canceling
  return "running";
}

/**
 * Checks if a run is in a terminal state (completed, cancelled, etc.)
 *
 * @param run - The Azure DevOps run
 * @returns True if the run is in a terminal state
 */
export function isRunTerminal(run: AzDoPipelineRun): boolean {
  return run.status === "completed";
}

/**
 * Checks if a run was successful
 *
 * @param run - The Azure DevOps run
 * @returns True if the run completed successfully
 */
export function isRunSuccessful(run: AzDoPipelineRun): boolean {
  return (
    run.status === "completed" &&
    (run.result === "succeeded" || run.result === "partiallySucceeded")
  );
}
