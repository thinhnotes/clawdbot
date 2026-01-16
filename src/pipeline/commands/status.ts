/**
 * Pipeline Status Command
 *
 * Implements the /pipeline-status [pipeline-id] command for viewing
 * pipeline status and progress.
 *
 * Usage:
 *   /pipeline-status                    - List all pipelines
 *   /pipeline-status <pipeline-id>      - Show detailed status for specific pipeline
 *
 * The command:
 * 1. Parses command arguments (optional pipeline-id)
 * 2. Lists all pipelines if no ID provided
 * 3. Shows detailed status for specific pipeline
 * 4. Displays current stage, pending approvals, recent history
 */

import type { ApprovalHistoryEntry } from "../approval-types.js";
import * as approval from "../approval.js";
import * as ops from "../ops.js";
import type { PipelineServiceState } from "../state.js";
import type {
  ApprovalRequest,
  Pipeline,
  PipelineStatus,
  Stage,
  StageStatus,
} from "../types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Command context for pipeline-status command.
 */
export type StatusCommandContext = {
  /** The user executing the command */
  userId: string;
  /** Whether the user is authorized to view pipeline status */
  isAuthorized: boolean;
};

/**
 * Parsed status command arguments.
 */
export type StatusCommandArgs = {
  /** Optional pipeline ID or name to get detailed status for */
  pipelineId?: string;
};

/**
 * Status summary for a single pipeline in list view.
 */
export type PipelineSummary = {
  /** Pipeline ID */
  id: string;
  /** Pipeline name */
  name: string;
  /** Current pipeline status */
  status: PipelineStatus;
  /** Current stage name (if running) */
  currentStageName?: string;
  /** Current stage status (if running) */
  currentStageStatus?: StageStatus;
  /** Number of completed stages */
  completedStages: number;
  /** Total number of stages */
  totalStages: number;
  /** Number of pending approvals */
  pendingApprovals: number;
  /** When the pipeline was created */
  createdAtMs: number;
  /** When the pipeline was last updated */
  updatedAtMs: number;
};

/**
 * Detailed stage status for a pipeline.
 */
export type StageDetail = {
  /** Stage ID */
  id: string;
  /** Stage name */
  name: string;
  /** Stage status */
  status: StageStatus;
  /** Stage order in pipeline */
  order: number;
  /** Whether this is the current stage */
  isCurrent: boolean;
  /** Whether approval is required for this stage */
  approvalRequired: boolean;
  /** Start time (if started) */
  startedAtMs?: number;
  /** Completion time (if completed) */
  completedAtMs?: number;
  /** Pending approval for this stage (if any) */
  pendingApproval?: ApprovalRequest;
  /** Stage error (if failed) */
  error?: string;
};

/**
 * Detailed pipeline status.
 */
export type PipelineDetail = {
  /** The pipeline */
  pipeline: Pipeline;
  /** Detailed stage information */
  stages: StageDetail[];
  /** All pending approvals for this pipeline */
  pendingApprovals: ApprovalRequest[];
  /** Recent approval history */
  recentHistory: ApprovalHistoryEntry[];
};

/**
 * Result of the status command execution.
 */
export type StatusCommandResult = {
  /** Whether the command succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** List of pipeline summaries (if listing all) */
  pipelines?: PipelineSummary[];
  /** Detailed pipeline status (if viewing specific pipeline) */
  detail?: PipelineDetail;
  /** Error code (if failed) */
  errorCode?: StatusErrorCode;
};

/**
 * Error codes for status command failures.
 */
export type StatusErrorCode =
  | "INVALID_ARGS"
  | "PIPELINE_NOT_FOUND"
  | "PERMISSION_DENIED";

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Parses the status command arguments from raw input.
 *
 * Expected format: [pipeline-id]
 *
 * @param raw - The raw command arguments string
 * @returns Parsed arguments (always valid, even if empty)
 */
export function parseStatusArgs(raw: string): StatusCommandArgs {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  // Split into tokens, respecting quotes for pipeline names with spaces
  const tokens = tokenize(trimmed);

  if (tokens.length === 0) {
    return {};
  }

  return {
    pipelineId: tokens[0],
  };
}

/**
 * Tokenizes a command string, handling quoted values.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = "";
      continue;
    }

    if (!inQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// ============================================================================
// Pipeline/Stage Resolution
// ============================================================================

/**
 * Finds a pipeline by ID or name.
 *
 * @param state - Pipeline service state
 * @param idOrName - Pipeline ID or name to find
 * @returns The pipeline or null if not found
 */
export async function findPipeline(
  state: PipelineServiceState,
  idOrName: string
): Promise<Pipeline | null> {
  // Try by exact ID first
  const byId = await ops.get(state, idOrName);
  if (byId) {
    return byId;
  }

  // Try by name (case-insensitive)
  const pipelines = await ops.list(state, { includeCompleted: true });
  const byName = pipelines.find(
    (p) => p.name.toLowerCase() === idOrName.toLowerCase()
  );

  return byName ?? null;
}

// ============================================================================
// Status Formatting Helpers
// ============================================================================

/**
 * Gets a status emoji for a pipeline status.
 */
function getPipelineStatusEmoji(status: PipelineStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "paused":
      return "⏸️";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "🚫";
    default:
      return "❓";
  }
}

/**
 * Gets a status emoji for a stage status.
 */
function getStageStatusEmoji(status: StageStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "awaiting_approval":
      return "🔔";
    case "approved":
      return "✅";
    case "rejected":
      return "❌";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    default:
      return "❓";
  }
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Formats a timestamp to a relative time string.
 */
function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diff = nowMs - timestampMs;
  if (diff < 0) {
    return "in the future";
  }
  return `${formatDuration(diff)} ago`;
}

// ============================================================================
// Status Collection
// ============================================================================

/**
 * Builds a summary for a pipeline.
 */
async function buildPipelineSummary(
  state: PipelineServiceState,
  pipeline: Pipeline
): Promise<PipelineSummary> {
  const pendingApprovals = await approval.getPendingApprovalsForPipeline(
    state,
    pipeline.id
  );

  const currentStage = pipeline.currentStageId
    ? pipeline.stages.find((s) => s.id === pipeline.currentStageId)
    : undefined;

  const completedStages = pipeline.stages.filter(
    (s) => s.status === "completed" || s.status === "approved"
  ).length;

  return {
    id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    currentStageName: currentStage?.name,
    currentStageStatus: currentStage?.status,
    completedStages,
    totalStages: pipeline.stages.length,
    pendingApprovals: pendingApprovals.length,
    createdAtMs: pipeline.createdAtMs,
    updatedAtMs: pipeline.updatedAtMs,
  };
}

/**
 * Builds detailed status for a pipeline.
 */
async function buildPipelineDetail(
  state: PipelineServiceState,
  pipeline: Pipeline
): Promise<PipelineDetail> {
  const pendingApprovals = await approval.getPendingApprovalsForPipeline(
    state,
    pipeline.id
  );

  const recentHistory = await approval.getPipelineApprovalHistory(
    state,
    pipeline.id,
    { limit: 5 }
  );

  // Build detailed stage information
  const stages: StageDetail[] = pipeline.stages
    .sort((a, b) => a.order - b.order)
    .map((stage) => {
      const pendingApproval = pendingApprovals.find(
        (a) => a.stageId === stage.id
      );

      return {
        id: stage.id,
        name: stage.name,
        status: stage.status,
        order: stage.order,
        isCurrent: stage.id === pipeline.currentStageId,
        approvalRequired: stage.approvalConfig.required,
        startedAtMs: stage.state.startedAtMs,
        completedAtMs: stage.state.completedAtMs,
        pendingApproval,
        error: stage.state.error,
      };
    });

  return {
    pipeline,
    stages,
    pendingApprovals,
    recentHistory,
  };
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Formats the list of pipelines as a human-readable message.
 */
function formatPipelineList(summaries: PipelineSummary[], nowMs: number): string {
  if (summaries.length === 0) {
    return "No pipelines found.";
  }

  const lines: string[] = ["**Pipelines:**", ""];

  for (const summary of summaries) {
    const emoji = getPipelineStatusEmoji(summary.status);
    const progress = `${summary.completedStages}/${summary.totalStages}`;
    const currentInfo = summary.currentStageName
      ? ` | Current: ${summary.currentStageName} (${summary.currentStageStatus})`
      : "";
    const approvalInfo =
      summary.pendingApprovals > 0
        ? ` | ⚠️ ${summary.pendingApprovals} pending approval(s)`
        : "";
    const age = formatRelativeTime(summary.createdAtMs, nowMs);

    lines.push(
      `${emoji} **${summary.name}** [${summary.status}] - ${progress} stages${currentInfo}${approvalInfo}`
    );
    lines.push(`   ID: \`${summary.id}\` | Created: ${age}`);
    lines.push("");
  }

  lines.push("Use `/pipeline-status <id>` for detailed status.");

  return lines.join("\n");
}

/**
 * Formats detailed pipeline status as a human-readable message.
 */
function formatPipelineDetail(detail: PipelineDetail, nowMs: number): string {
  const { pipeline, stages, pendingApprovals, recentHistory } = detail;
  const lines: string[] = [];

  // Header
  const emoji = getPipelineStatusEmoji(pipeline.status);
  lines.push(`${emoji} **${pipeline.name}**`);
  lines.push(`Status: ${pipeline.status} | ID: \`${pipeline.id}\``);
  if (pipeline.description) {
    lines.push(`Description: ${pipeline.description}`);
  }
  lines.push("");

  // Stages
  lines.push("**Stages:**");
  for (const stage of stages) {
    const stageEmoji = getStageStatusEmoji(stage.status);
    const current = stage.isCurrent ? " ← current" : "";
    const approvalMark = stage.approvalRequired ? " 🔐" : "";

    let timing = "";
    if (stage.startedAtMs && stage.completedAtMs) {
      const duration = formatDuration(stage.completedAtMs - stage.startedAtMs);
      timing = ` (${duration})`;
    } else if (stage.startedAtMs) {
      const running = formatDuration(nowMs - stage.startedAtMs);
      timing = ` (running ${running})`;
    }

    lines.push(
      `  ${stage.order}. ${stageEmoji} ${stage.name} [${stage.status}]${approvalMark}${timing}${current}`
    );

    if (stage.error) {
      lines.push(`      ❗ Error: ${stage.error}`);
    }

    if (stage.pendingApproval) {
      const waitTime = formatDuration(nowMs - stage.pendingApproval.requestedAtMs);
      lines.push(`      ⏱️ Awaiting approval for ${waitTime}`);
      if (stage.pendingApproval.expiresAtMs) {
        const remaining = stage.pendingApproval.expiresAtMs - nowMs;
        if (remaining > 0) {
          lines.push(`      ⏳ Expires in ${formatDuration(remaining)}`);
        } else {
          lines.push("      ⚠️ Expired!");
        }
      }
    }
  }
  lines.push("");

  // Pending Approvals
  if (pendingApprovals.length > 0) {
    lines.push("**Pending Approvals:**");
    for (const req of pendingApprovals) {
      const stage = stages.find((s) => s.id === req.stageId);
      const stageName = stage?.name ?? req.stageId;
      const waitTime = formatDuration(nowMs - req.requestedAtMs);
      lines.push(`  - Stage "${stageName}" (waiting ${waitTime})`);
      lines.push(`    \`/approve ${pipeline.id} ${req.stageId}\` or \`/reject ${pipeline.id} ${req.stageId}\``);
    }
    lines.push("");
  }

  // Recent History
  if (recentHistory.length > 0) {
    lines.push("**Recent Approval History:**");
    for (const entry of recentHistory) {
      const stage = stages.find((s) => s.id === entry.stageId);
      const stageName = stage?.name ?? entry.stageId;
      const action = entry.action ?? entry.status;
      const when = entry.processedAtMs
        ? formatRelativeTime(entry.processedAtMs, nowMs)
        : formatRelativeTime(entry.requestedAtMs, nowMs);
      const by = entry.processedBy ? ` by ${entry.processedBy}` : "";
      lines.push(`  - ${stageName}: ${action}${by} (${when})`);
    }
    lines.push("");
  }

  // Footer with pipeline age
  const created = formatRelativeTime(pipeline.createdAtMs, nowMs);
  const updated = formatRelativeTime(pipeline.updatedAtMs, nowMs);
  lines.push(`Created: ${created} | Last updated: ${updated}`);

  return lines.join("\n");
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Executes the status command to list all pipelines.
 */
export async function executeListPipelines(
  state: PipelineServiceState,
  context: StatusCommandContext
): Promise<StatusCommandResult> {
  // Check authorization
  if (!context.isAuthorized) {
    return {
      success: false,
      message: "You do not have permission to view pipeline status",
      errorCode: "PERMISSION_DENIED",
    };
  }

  // Get all pipelines
  const allPipelines = await ops.list(state, { includeCompleted: true });

  // Build summaries
  const summaries: PipelineSummary[] = [];
  for (const pipeline of allPipelines) {
    const summary = await buildPipelineSummary(state, pipeline);
    summaries.push(summary);
  }

  // Sort by updated time (most recent first)
  summaries.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const nowMs = state.deps.nowMs();
  const message = formatPipelineList(summaries, nowMs);

  return {
    success: true,
    message,
    pipelines: summaries,
  };
}

/**
 * Executes the status command to show detailed status for a specific pipeline.
 */
export async function executeGetPipelineStatus(
  state: PipelineServiceState,
  args: StatusCommandArgs,
  context: StatusCommandContext
): Promise<StatusCommandResult> {
  // Check authorization
  if (!context.isAuthorized) {
    return {
      success: false,
      message: "You do not have permission to view pipeline status",
      errorCode: "PERMISSION_DENIED",
    };
  }

  if (!args.pipelineId) {
    return {
      success: false,
      message: "Pipeline ID is required for detailed status",
      errorCode: "INVALID_ARGS",
    };
  }

  // Find the pipeline
  const pipeline = await findPipeline(state, args.pipelineId);
  if (!pipeline) {
    return {
      success: false,
      message: `Pipeline not found: ${args.pipelineId}`,
      errorCode: "PIPELINE_NOT_FOUND",
    };
  }

  // Build detailed status
  const detail = await buildPipelineDetail(state, pipeline);

  const nowMs = state.deps.nowMs();
  const message = formatPipelineDetail(detail, nowMs);

  return {
    success: true,
    message,
    detail,
  };
}

/**
 * Executes the status command.
 *
 * @param state - Pipeline service state
 * @param args - Parsed command arguments
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function executeStatus(
  state: PipelineServiceState,
  args: StatusCommandArgs,
  context: StatusCommandContext
): Promise<StatusCommandResult> {
  if (args.pipelineId) {
    return executeGetPipelineStatus(state, args, context);
  }
  return executeListPipelines(state, context);
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Handles the /pipeline-status command.
 *
 * This is the main entry point for the status command, combining parsing,
 * validation, and execution.
 *
 * @param state - Pipeline service state
 * @param rawArgs - Raw command arguments string
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function handleStatusCommand(
  state: PipelineServiceState,
  rawArgs: string,
  context: StatusCommandContext
): Promise<StatusCommandResult> {
  // Parse arguments
  const args = parseStatusArgs(rawArgs);

  // Execute the status check
  return executeStatus(state, args, context);
}

// ============================================================================
// Help Text
// ============================================================================

/**
 * Returns the help text for the pipeline-status command.
 */
export function getStatusHelpText(): string {
  return `
/pipeline-status [pipeline-id]

View pipeline status and progress.

Arguments:
  pipeline-id   Optional pipeline ID or name for detailed status

Usage:
  /pipeline-status                    List all pipelines
  /pipeline-status abc123             Detailed status for pipeline abc123
  /pipeline-status "My Pipeline"      Detailed status by name

The detailed view shows:
  - Pipeline status and description
  - All stages with their current status
  - Pending approvals with commands to approve/reject
  - Recent approval history

Notes:
  - Pipeline names with spaces must be quoted
  - Use pipeline ID or name (case-insensitive)
`.trim();
}

// ============================================================================
// Command Definition (for registry)
// ============================================================================

/**
 * Command definition for the pipeline-status command.
 * Can be used when registering with the command system.
 */
export const STATUS_COMMAND_DEFINITION = {
  key: "pipeline-status",
  nativeName: "pipeline-status",
  description: "View pipeline status and progress.",
  textAliases: ["/pipeline-status", "/ps"],
  acceptsArgs: true,
  args: [
    {
      name: "pipelineId",
      description: "Optional pipeline ID or name",
      type: "string" as const,
    },
  ],
} as const;
