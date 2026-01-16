/**
 * Pipeline CLI Commands
 *
 * CLI interface for pipeline operations including triggering pipelines,
 * checking status, managing approvals, fetching logs, and viewing history.
 *
 * Commands:
 * - pipeline trigger <name>         - Trigger a pipeline
 * - pipeline status <runId>         - Get run status
 * - pipeline approve <approvalId>   - Approve a pending approval
 * - pipeline reject <approvalId>    - Reject a pending approval
 * - pipeline logs <runId> [stage]   - Get build logs
 * - pipeline history [name]         - Get pipeline history
 * - pipeline list                   - List available pipelines
 * - pipeline pending                - List pending approvals
 * - pipeline cancel <runId>         - Cancel a pipeline run
 *
 * @example
 * ```bash
 * # Trigger a pipeline on a specific branch
 * clawd pipeline trigger build-and-deploy --branch feature/new-feature
 *
 * # Check pipeline status
 * clawd pipeline status run-12345
 *
 * # Approve a pending stage
 * clawd pipeline approve approval-abc --comment "LGTM"
 *
 * # Fetch logs for a stage
 * clawd pipeline logs run-12345 --stage deploy
 *
 * # View recent pipeline history
 * clawd pipeline history --limit 5
 * ```
 */

import type { Command } from "commander";

import type { PipelineConfig } from "./config.js";
import type { PipelineRuntime } from "./runtime.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Parameters for registering pipeline CLI commands
 */
export interface RegisterPipelineCLIParams {
  /** Commander program instance */
  program: Command;
  /** Pipeline configuration */
  config: PipelineConfig;
  /** Function to ensure runtime is initialized */
  ensureRuntime: () => Promise<PipelineRuntime>;
  /** Logger for CLI output */
  logger: Logger;
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Format a timestamp as a relative time string
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 0) {
    // Future time
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return "in a few seconds";
    if (absDiff < 3600000) return `in ${Math.floor(absDiff / 60000)}m`;
    return `in ${Math.floor(absDiff / 3600000)}h`;
  }

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// -----------------------------------------------------------------------------
// CLI Registration
// -----------------------------------------------------------------------------

/**
 * Register pipeline CLI commands
 */
export function registerPipelineCli(params: RegisterPipelineCLIParams): void {
  const { program, config, ensureRuntime, logger } = params;

  // Check if pipeline is enabled
  const checkEnabled = (): void => {
    if (!config.enabled) {
      throw new Error("Pipeline plugin is disabled in configuration");
    }
  };

  const root = program
    .command("pipeline")
    .description("CI/CD pipeline management with approval gates")
    .addHelpText(
      "after",
      () => `
Commands:
  trigger <name>           Trigger a pipeline run
  status <runId>           Get pipeline run status
  approve <approvalId>     Approve a pending stage approval
  reject <approvalId>      Reject a pending stage approval
  logs <runId>             Get build logs for a pipeline run
  history                  View pipeline run history
  list                     List available pipelines
  pending                  List pending approvals
  cancel <runId>           Cancel a pipeline run

Examples:
  $ clawd pipeline trigger build-and-deploy --branch main
  $ clawd pipeline status run-12345 --refresh
  $ clawd pipeline approve approval-abc --comment "LGTM"
  $ clawd pipeline logs run-12345 --stage deploy
  $ clawd pipeline history --limit 10
`
    );

  // -------------------------------------------------------------------------
  // pipeline trigger <name>
  // -------------------------------------------------------------------------
  root
    .command("trigger <pipelineName>")
    .description("Trigger a pipeline run")
    .option("-b, --branch <branch>", "Branch to build (uses default if not set)")
    .option(
      "-p, --param <key=value...>",
      "Pipeline parameters (can be specified multiple times)"
    )
    .option("--commit <commitId>", "Specific commit SHA to build")
    .option("--json", "Output result as JSON")
    .action(
      async (
        pipelineName: string,
        options: {
          branch?: string;
          param?: string[];
          commit?: string;
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        // Parse parameters from key=value format
        const parameters: Record<string, string> = {};
        if (options.param) {
          for (const p of options.param) {
            const eqIndex = p.indexOf("=");
            if (eqIndex > 0) {
              const key = p.substring(0, eqIndex).trim();
              const value = p.substring(eqIndex + 1).trim();
              parameters[key] = value;
            }
          }
        }

        const result = await rt.manager.triggerPipeline({
          pipelineId: pipelineName,
          branch: options.branch,
          parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
          commitId: options.commit,
        });

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                success: true,
                runId: result.runId,
                providerRunId: result.providerRunId,
                webUrl: result.webUrl,
                state: result.run.state,
                pipelineName: result.run.pipelineName,
                branch: result.run.sourceBranch,
                stages: result.run.stages.map((s) => ({
                  name: s.name,
                  state: s.state,
                  hasApprovalGate: s.hasApprovalGate,
                })),
              },
              null,
              2
            )
          );
        } else {
          logger.info(
            `✓ Pipeline "${result.run.pipelineName}" triggered successfully`
          );
          // eslint-disable-next-line no-console
          console.log(`  Run ID:      ${result.runId}`);
          // eslint-disable-next-line no-console
          console.log(`  State:       ${result.run.state}`);
          if (result.run.sourceBranch) {
            // eslint-disable-next-line no-console
            console.log(`  Branch:      ${result.run.sourceBranch}`);
          }
          if (result.webUrl) {
            // eslint-disable-next-line no-console
            console.log(`  URL:         ${result.webUrl}`);
          }
          // eslint-disable-next-line no-console
          console.log(`  Stages:      ${result.run.stages.length}`);
          for (const stage of result.run.stages) {
            const gate = stage.hasApprovalGate ? " [approval gate]" : "";
            // eslint-disable-next-line no-console
            console.log(`    - ${stage.name} (${stage.state})${gate}`);
          }
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline status <runId>
  // -------------------------------------------------------------------------
  root
    .command("status <runId>")
    .description("Get pipeline run status")
    .option("-r, --refresh", "Refresh status from provider")
    .option("--json", "Output result as JSON")
    .action(
      async (
        runId: string,
        options: {
          refresh?: boolean;
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        const run = await rt.manager.getStatus({
          runId,
          refresh: options.refresh,
        });

        if (!run) {
          if (options.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({ found: false, runId }, null, 2));
          } else {
            logger.error(`Pipeline run "${runId}" not found`);
          }
          return;
        }

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                found: true,
                id: run.id,
                providerRunId: run.providerRunId,
                state: run.state,
                result: run.result,
                pipelineId: run.pipelineId,
                pipelineName: run.pipelineName,
                sourceBranch: run.sourceBranch,
                triggeredBy: run.triggeredBy,
                webUrl: run.webUrl,
                queuedAt: run.queuedAt,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                durationMs: run.durationMs,
                stages: run.stages.map((s) => ({
                  id: s.id,
                  name: s.name,
                  state: s.state,
                  result: s.result,
                  hasApprovalGate: s.hasApprovalGate,
                })),
              },
              null,
              2
            )
          );
        } else {
          const stateIcon = getStateIcon(run.state);
          // eslint-disable-next-line no-console
          console.log(`\n${stateIcon} Pipeline: ${run.pipelineName}`);
          // eslint-disable-next-line no-console
          console.log(`  Run ID:      ${run.id}`);
          // eslint-disable-next-line no-console
          console.log(`  State:       ${run.state}`);
          if (run.result) {
            // eslint-disable-next-line no-console
            console.log(`  Result:      ${run.result}`);
          }
          if (run.sourceBranch) {
            // eslint-disable-next-line no-console
            console.log(`  Branch:      ${run.sourceBranch}`);
          }
          if (run.triggeredBy) {
            // eslint-disable-next-line no-console
            console.log(`  Triggered:   ${run.triggeredBy}`);
          }
          if (run.queuedAt) {
            // eslint-disable-next-line no-console
            console.log(`  Queued:      ${formatRelativeTime(run.queuedAt)}`);
          }
          if (run.durationMs) {
            // eslint-disable-next-line no-console
            console.log(`  Duration:    ${formatDuration(run.durationMs)}`);
          }
          if (run.webUrl) {
            // eslint-disable-next-line no-console
            console.log(`  URL:         ${run.webUrl}`);
          }

          // eslint-disable-next-line no-console
          console.log(`\n  Stages:`);
          for (const stage of run.stages) {
            const icon = getStateIcon(stage.state);
            const gate = stage.hasApprovalGate ? " [approval]" : "";
            // eslint-disable-next-line no-console
            console.log(`    ${icon} ${stage.name}${gate}`);
          }
          // eslint-disable-next-line no-console
          console.log("");
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline approve <approvalId>
  // -------------------------------------------------------------------------
  root
    .command("approve <approvalId>")
    .description("Approve a pending stage approval")
    .option("-c, --comment <text>", "Approval comment")
    .option("--json", "Output result as JSON")
    .action(
      async (
        approvalId: string,
        options: {
          comment?: string;
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        const result = await rt.manager.approve(approvalId, {
          comment: options.comment,
        });

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                success: result.success,
                approvalId: result.approvalId,
                decision: result.decision,
                runId: result.runId,
                stageId: result.stageId,
                error: result.error,
              },
              null,
              2
            )
          );
        } else {
          if (result.success) {
            logger.info(`✓ Approval "${approvalId}" approved successfully`);
            // eslint-disable-next-line no-console
            console.log(`  Run ID:   ${result.runId}`);
            // eslint-disable-next-line no-console
            console.log(`  Stage ID: ${result.stageId}`);
          } else {
            logger.error(`✗ Failed to approve: ${result.error}`);
          }
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline reject <approvalId>
  // -------------------------------------------------------------------------
  root
    .command("reject <approvalId>")
    .description("Reject a pending stage approval")
    .option("-c, --comment <text>", "Rejection reason")
    .option("--json", "Output result as JSON")
    .action(
      async (
        approvalId: string,
        options: {
          comment?: string;
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        // Check if comment is required
        if (config.approval?.requireRejectComment && !options.comment) {
          throw new Error(
            "Rejection comment is required. Use --comment <text> to provide a reason."
          );
        }

        const result = await rt.manager.reject(approvalId, {
          comment: options.comment,
        });

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                success: result.success,
                approvalId: result.approvalId,
                decision: result.decision,
                runId: result.runId,
                stageId: result.stageId,
                error: result.error,
              },
              null,
              2
            )
          );
        } else {
          if (result.success) {
            logger.info(`✓ Approval "${approvalId}" rejected`);
            // eslint-disable-next-line no-console
            console.log(`  Run ID:   ${result.runId}`);
            // eslint-disable-next-line no-console
            console.log(`  Stage ID: ${result.stageId}`);
          } else {
            logger.error(`✗ Failed to reject: ${result.error}`);
          }
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline logs <runId>
  // -------------------------------------------------------------------------
  root
    .command("logs <runId>")
    .description("Get build logs for a pipeline run")
    .option("-s, --stage <stageId>", "Stage name or ID to get logs for")
    .option("-n, --lines <count>", "Maximum number of lines to show", "100")
    .option("--json", "Output result as JSON")
    .action(
      async (
        runId: string,
        options: {
          stage?: string;
          lines?: string;
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        const result = await rt.manager.getLogs({
          runId,
          stageId: options.stage,
        });

        const maxLines = Math.max(1, parseInt(options.lines ?? "100", 10));
        const truncated = result.logs.length > maxLines;
        const displayLogs = truncated ? result.logs.slice(0, maxLines) : result.logs;

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                runId,
                stageId: result.stageId,
                totalLines: result.logs.length,
                logs: displayLogs,
                truncated,
              },
              null,
              2
            )
          );
        } else {
          if (result.stageId) {
            // eslint-disable-next-line no-console
            console.log(`\n--- Logs for stage: ${result.stageId} ---\n`);
          } else {
            // eslint-disable-next-line no-console
            console.log(`\n--- Logs for run: ${runId} ---\n`);
          }

          for (const line of displayLogs) {
            // eslint-disable-next-line no-console
            console.log(line);
          }

          if (truncated) {
            // eslint-disable-next-line no-console
            console.log(
              `\n... truncated (showing ${maxLines} of ${result.logs.length} lines)`
            );
          }
          // eslint-disable-next-line no-console
          console.log("");
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline history
  // -------------------------------------------------------------------------
  root
    .command("history")
    .description("View pipeline run history")
    .option("-p, --pipeline <name>", "Filter by pipeline name or ID")
    .option("-s, --state <state>", "Filter by state (queued, running, succeeded, failed, etc.)")
    .option("-l, --limit <count>", "Maximum number of runs to show", "10")
    .option("--json", "Output result as JSON")
    .action(
      async (options: {
        pipeline?: string;
        state?: string;
        limit?: string;
        json?: boolean;
      }) => {
        checkEnabled();
        const rt = await ensureRuntime();

        const limit = Math.min(50, Math.max(1, parseInt(options.limit ?? "10", 10)));
        const state = options.state as
          | "queued"
          | "running"
          | "waiting_for_approval"
          | "succeeded"
          | "failed"
          | "cancelled"
          | undefined;

        const result = await rt.manager.getHistory({
          pipelineId: options.pipeline,
          state,
          limit,
        });

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                runs: result.runs.map((r) => ({
                  id: r.id,
                  providerRunId: r.providerRunId,
                  state: r.state,
                  result: r.result,
                  pipelineId: r.pipelineId,
                  pipelineName: r.pipelineName,
                  sourceBranch: r.sourceBranch,
                  webUrl: r.webUrl,
                  queuedAt: r.queuedAt,
                  finishedAt: r.finishedAt,
                  durationMs: r.durationMs,
                })),
                totalCount: result.totalCount,
                hasMore: result.hasMore,
              },
              null,
              2
            )
          );
        } else {
          if (result.runs.length === 0) {
            logger.info("No pipeline runs found");
            return;
          }

          // eslint-disable-next-line no-console
          console.log(`\nPipeline History (${result.totalCount} total):\n`);

          for (const run of result.runs) {
            const icon = getStateIcon(run.state);
            const duration = run.durationMs ? formatDuration(run.durationMs) : "-";
            const time = run.queuedAt ? formatRelativeTime(run.queuedAt) : "-";

            // eslint-disable-next-line no-console
            console.log(`${icon} ${run.pipelineName}`);
            // eslint-disable-next-line no-console
            console.log(`    ID: ${run.id}  Branch: ${run.sourceBranch ?? "-"}  Duration: ${duration}  ${time}`);
          }

          if (result.hasMore) {
            // eslint-disable-next-line no-console
            console.log(`\n  ... and ${result.totalCount - result.runs.length} more`);
          }
          // eslint-disable-next-line no-console
          console.log("");
        }
      }
    );

  // -------------------------------------------------------------------------
  // pipeline list
  // -------------------------------------------------------------------------
  root
    .command("list")
    .description("List available pipelines")
    .option("--json", "Output result as JSON")
    .action(async (options: { json?: boolean }) => {
      checkEnabled();
      const rt = await ensureRuntime();

      const pipelines = await rt.manager.listPipelines();

      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              pipelines: pipelines.map((p) => ({
                id: p.id,
                name: p.name,
                path: p.path,
                defaultBranch: p.defaultBranch,
                webUrl: p.webUrl,
              })),
              count: pipelines.length,
            },
            null,
            2
          )
        );
      } else {
        if (pipelines.length === 0) {
          logger.info("No pipelines found");
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`\nAvailable Pipelines (${pipelines.length}):\n`);

        for (const pipeline of pipelines) {
          // eslint-disable-next-line no-console
          console.log(`  • ${pipeline.name}`);
          // eslint-disable-next-line no-console
          console.log(`    ID: ${pipeline.id}`);
          if (pipeline.path) {
            // eslint-disable-next-line no-console
            console.log(`    Path: ${pipeline.path}`);
          }
          if (pipeline.defaultBranch) {
            // eslint-disable-next-line no-console
            console.log(`    Default Branch: ${pipeline.defaultBranch}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log("");
      }
    });

  // -------------------------------------------------------------------------
  // pipeline pending
  // -------------------------------------------------------------------------
  root
    .command("pending")
    .description("List pending approvals")
    .option("--json", "Output result as JSON")
    .action(async (options: { json?: boolean }) => {
      checkEnabled();
      const rt = await ensureRuntime();

      const approvals = rt.manager.getPendingApprovals();

      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              approvals: approvals.map((a) => ({
                id: a.id,
                runId: a.runId,
                stageId: a.stageId,
                stageName: a.stageName,
                pipelineName: a.pipelineName,
                createdAt: a.createdAt,
                expiresAt: a.expiresAt,
                approvers: a.approvers,
                instructions: a.instructions,
              })),
              count: approvals.length,
            },
            null,
            2
          )
        );
      } else {
        if (approvals.length === 0) {
          logger.info("No pending approvals");
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`\nPending Approvals (${approvals.length}):\n`);

        for (const approval of approvals) {
          const expiresIn = approval.expiresAt
            ? formatRelativeTime(approval.expiresAt)
            : "never";

          // eslint-disable-next-line no-console
          console.log(`  ⏳ ${approval.pipelineName} → ${approval.stageName}`);
          // eslint-disable-next-line no-console
          console.log(`    Approval ID: ${approval.id}`);
          // eslint-disable-next-line no-console
          console.log(`    Run ID:      ${approval.runId}`);
          // eslint-disable-next-line no-console
          console.log(`    Expires:     ${expiresIn}`);
          if (approval.instructions) {
            // eslint-disable-next-line no-console
            console.log(`    Note:        ${approval.instructions}`);
          }
          if (approval.approvers && approval.approvers.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`    Approvers:   ${approval.approvers.join(", ")}`);
          }
          // eslint-disable-next-line no-console
          console.log("");
        }
      }
    });

  // -------------------------------------------------------------------------
  // pipeline cancel <runId>
  // -------------------------------------------------------------------------
  root
    .command("cancel <runId>")
    .description("Cancel a pipeline run")
    .option("--json", "Output result as JSON")
    .action(
      async (
        runId: string,
        options: {
          json?: boolean;
        }
      ) => {
        checkEnabled();
        const rt = await ensureRuntime();

        await rt.manager.cancelPipeline(runId);

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                success: true,
                cancelled: true,
                runId,
              },
              null,
              2
            )
          );
        } else {
          logger.info(`✓ Pipeline run "${runId}" cancelled`);
        }
      }
    );
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Get an icon/emoji for a pipeline or stage state
 */
function getStateIcon(
  state: string
): string {
  switch (state) {
    case "queued":
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "waiting_for_approval":
      return "⏸️";
    case "approved":
    case "succeeded":
      return "✅";
    case "rejected":
    case "failed":
      return "❌";
    case "cancelled":
    case "skipped":
      return "⏭️";
    default:
      return "•";
  }
}
