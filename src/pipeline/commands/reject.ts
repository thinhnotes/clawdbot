/**
 * Reject Command
 *
 * Implements the /reject <pipeline-id> <stage> command for rejecting
 * pipeline stages that are awaiting approval.
 *
 * Usage:
 *   /reject <pipeline-id> <stage-id> [reason]
 *
 * The command:
 * 1. Parses command arguments (pipeline-id, stage-id, optional reason)
 * 2. Validates the pipeline exists and stage is awaiting approval
 * 3. Checks user has rejection permissions
 * 4. Calls the approval service to process the rejection
 * 5. Returns a confirmation message
 */

import type { ApprovalResult } from "../approval-types.js";
import * as ops from "../ops.js";
import type { PipelineServiceState } from "../state.js";
import type { Pipeline, Stage } from "../types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Command context for reject command.
 */
export type RejectCommandContext = {
  /** The user executing the command */
  userId: string;
  /** Whether the user is authorized for rejection operations */
  isAuthorized: boolean;
  /** List of users with rejection permissions (if configured) */
  approverList?: string[];
};

/**
 * Parsed reject command arguments.
 */
export type RejectCommandArgs = {
  /** The pipeline ID or name */
  pipelineId: string;
  /** The stage ID or name */
  stageId: string;
  /** Optional reason explaining the rejection */
  reason?: string;
};

/**
 * Result of the reject command execution.
 */
export type RejectCommandResult = {
  /** Whether the command succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** The pipeline that was rejected (if successful) */
  pipeline?: Pipeline;
  /** The stage that was rejected (if successful) */
  stage?: Stage;
  /** The rejection result (if successful) */
  rejectionResult?: ApprovalResult;
  /** Error code (if failed) */
  errorCode?: RejectErrorCode;
};

/**
 * Error codes for reject command failures.
 */
export type RejectErrorCode =
  | "INVALID_ARGS"
  | "PIPELINE_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "NOT_AWAITING_APPROVAL"
  | "PERMISSION_DENIED"
  | "REJECTION_FAILED";

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Parses the reject command arguments from raw input.
 *
 * Expected format: <pipeline-id> <stage-id> [reason...]
 *
 * @param raw - The raw command arguments string
 * @returns Parsed arguments or null if invalid
 */
export function parseRejectArgs(raw: string): RejectCommandArgs | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Split into tokens, respecting quotes for pipeline/stage names with spaces
  const tokens = tokenize(trimmed);
  if (tokens.length < 2) {
    return null;
  }

  const pipelineId = tokens[0];
  const stageId = tokens[1];
  const reason = tokens.length > 2 ? tokens.slice(2).join(" ") : undefined;

  return {
    pipelineId,
    stageId,
    reason,
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
// Permission Checking
// ============================================================================

/**
 * Checks if a user has permission to reject a stage.
 *
 * @param context - The command execution context
 * @param stage - The stage being rejected
 * @returns Whether the user can reject the stage
 */
export function canReject(
  context: RejectCommandContext,
  stage: Stage
): boolean {
  // Must be authorized for pipeline operations
  if (!context.isAuthorized) {
    return false;
  }

  // If the stage has specific approvers configured, check the list
  // (Approvers can also reject)
  const { approvalConfig } = stage;
  if (approvalConfig.approvers && approvalConfig.approvers.length > 0) {
    return approvalConfig.approvers.includes(context.userId);
  }

  // If context has an approver list, check against it
  if (context.approverList && context.approverList.length > 0) {
    return context.approverList.includes(context.userId);
  }

  // Default: authorized users can reject
  return true;
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

/**
 * Finds a stage in a pipeline by ID or name.
 *
 * @param pipeline - The pipeline to search
 * @param idOrName - Stage ID or name to find
 * @returns The stage or null if not found
 */
export function findStage(pipeline: Pipeline, idOrName: string): Stage | null {
  // Try by exact ID first
  const byId = pipeline.stages.find((s) => s.id === idOrName);
  if (byId) {
    return byId;
  }

  // Try by name (case-insensitive)
  const byName = pipeline.stages.find(
    (s) => s.name.toLowerCase() === idOrName.toLowerCase()
  );

  return byName ?? null;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Executes the reject command.
 *
 * @param state - Pipeline service state
 * @param args - Parsed command arguments
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function executeReject(
  state: PipelineServiceState,
  args: RejectCommandArgs,
  context: RejectCommandContext
): Promise<RejectCommandResult> {
  // Find the pipeline
  const pipeline = await findPipeline(state, args.pipelineId);
  if (!pipeline) {
    return {
      success: false,
      message: `Pipeline not found: ${args.pipelineId}`,
      errorCode: "PIPELINE_NOT_FOUND",
    };
  }

  // Find the stage
  const stage = findStage(pipeline, args.stageId);
  if (!stage) {
    return {
      success: false,
      message: `Stage not found: ${args.stageId} in pipeline ${pipeline.name}`,
      errorCode: "STAGE_NOT_FOUND",
    };
  }

  // Validate stage is awaiting approval
  if (stage.status !== "awaiting_approval") {
    return {
      success: false,
      message: `Stage "${stage.name}" is not awaiting approval (current status: ${stage.status})`,
      errorCode: "NOT_AWAITING_APPROVAL",
    };
  }

  // Check permissions
  if (!canReject(context, stage)) {
    return {
      success: false,
      message: `You do not have permission to reject stage "${stage.name}"`,
      errorCode: "PERMISSION_DENIED",
    };
  }

  // Process the rejection
  const result = await ops.processApproval(
    state,
    pipeline.id,
    stage.id,
    "reject",
    {
      processedBy: context.userId,
      comment: args.reason,
    }
  );

  if (!result.ok) {
    return {
      success: false,
      message: `Failed to reject stage: ${result.error}`,
      errorCode: "REJECTION_FAILED",
    };
  }

  // Build success message
  const reasonPart = args.reason ? ` with reason: "${args.reason}"` : "";
  const message = `❌ Rejected stage "${stage.name}" in pipeline "${pipeline.name}"${reasonPart}`;

  return {
    success: true,
    message,
    pipeline,
    stage,
    rejectionResult: {
      action: "reject",
      approvedBy: context.userId,
      timestampMs: Date.now(),
      comment: args.reason,
      success: true,
    },
  };
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Handles the /reject command.
 *
 * This is the main entry point for the reject command, combining parsing,
 * validation, and execution.
 *
 * @param state - Pipeline service state
 * @param rawArgs - Raw command arguments string
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function handleRejectCommand(
  state: PipelineServiceState,
  rawArgs: string,
  context: RejectCommandContext
): Promise<RejectCommandResult> {
  // Parse arguments
  const args = parseRejectArgs(rawArgs);
  if (!args) {
    return {
      success: false,
      message: "Usage: /reject <pipeline-id> <stage-id> [reason]",
      errorCode: "INVALID_ARGS",
    };
  }

  // Execute the rejection
  return executeReject(state, args, context);
}

// ============================================================================
// Help Text
// ============================================================================

/**
 * Returns the help text for the reject command.
 */
export function getRejectHelpText(): string {
  return `
/reject <pipeline-id> <stage-id> [reason]

Reject a pipeline stage that is awaiting approval.

Arguments:
  pipeline-id   The ID or name of the pipeline
  stage-id      The ID or name of the stage to reject
  reason        Optional reason explaining the rejection

Examples:
  /reject abc123 build
  /reject "My Pipeline" "Build Stage"
  /reject abc123 build "Tests are failing, needs investigation"

Notes:
  - The stage must be in "awaiting_approval" status
  - You must have approval/rejection permissions for the stage
  - After rejection, the pipeline may be paused or failed depending on configuration
`.trim();
}

// ============================================================================
// Command Definition (for registry)
// ============================================================================

/**
 * Command definition for the reject command.
 * Can be used when registering with the command system.
 */
export const REJECT_COMMAND_DEFINITION = {
  key: "reject",
  nativeName: "reject",
  description: "Reject a pipeline stage awaiting approval.",
  textAliases: ["/reject"],
  acceptsArgs: true,
  args: [
    {
      name: "pipelineId",
      description: "Pipeline ID or name",
      type: "string" as const,
      required: true,
    },
    {
      name: "stageId",
      description: "Stage ID or name",
      type: "string" as const,
      required: true,
    },
    {
      name: "reason",
      description: "Optional rejection reason",
      type: "string" as const,
      captureRemaining: true,
    },
  ],
} as const;
