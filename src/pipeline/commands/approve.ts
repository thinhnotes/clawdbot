/**
 * Approve Command
 *
 * Implements the /approve <pipeline-id> <stage> command for approving
 * pipeline stages that are awaiting approval.
 *
 * Usage:
 *   /approve <pipeline-id> <stage-id> [comment]
 *
 * The command:
 * 1. Parses command arguments (pipeline-id, stage-id, optional comment)
 * 2. Validates the pipeline exists and stage is awaiting approval
 * 3. Checks user has approval permissions
 * 4. Calls the approval service to process the approval
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
 * Command context for approve command.
 */
export type ApproveCommandContext = {
  /** The user executing the command */
  userId: string;
  /** Whether the user is authorized for approval operations */
  isAuthorized: boolean;
  /** List of users with approval permissions (if configured) */
  approverList?: string[];
};

/**
 * Parsed approve command arguments.
 */
export type ApproveCommandArgs = {
  /** The pipeline ID or name */
  pipelineId: string;
  /** The stage ID or name */
  stageId: string;
  /** Optional comment explaining the approval */
  comment?: string;
};

/**
 * Result of the approve command execution.
 */
export type ApproveCommandResult = {
  /** Whether the command succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** The pipeline that was approved (if successful) */
  pipeline?: Pipeline;
  /** The stage that was approved (if successful) */
  stage?: Stage;
  /** The approval result (if successful) */
  approvalResult?: ApprovalResult;
  /** Error code (if failed) */
  errorCode?: ApproveErrorCode;
};

/**
 * Error codes for approve command failures.
 */
export type ApproveErrorCode =
  | "INVALID_ARGS"
  | "PIPELINE_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "NOT_AWAITING_APPROVAL"
  | "PERMISSION_DENIED"
  | "APPROVAL_FAILED";

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Parses the approve command arguments from raw input.
 *
 * Expected format: <pipeline-id> <stage-id> [comment...]
 *
 * @param raw - The raw command arguments string
 * @returns Parsed arguments or null if invalid
 */
export function parseApproveArgs(raw: string): ApproveCommandArgs | null {
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
  const comment = tokens.length > 2 ? tokens.slice(2).join(" ") : undefined;

  return {
    pipelineId,
    stageId,
    comment,
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
 * Checks if a user has permission to approve a stage.
 *
 * @param context - The command execution context
 * @param stage - The stage being approved
 * @returns Whether the user can approve the stage
 */
export function canApprove(
  context: ApproveCommandContext,
  stage: Stage
): boolean {
  // Must be authorized for pipeline operations
  if (!context.isAuthorized) {
    return false;
  }

  // If the stage has specific approvers configured, check the list
  const { approvalConfig } = stage;
  if (approvalConfig.approvers && approvalConfig.approvers.length > 0) {
    return approvalConfig.approvers.includes(context.userId);
  }

  // If context has an approver list, check against it
  if (context.approverList && context.approverList.length > 0) {
    return context.approverList.includes(context.userId);
  }

  // Default: authorized users can approve
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
 * Executes the approve command.
 *
 * @param state - Pipeline service state
 * @param args - Parsed command arguments
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function executeApprove(
  state: PipelineServiceState,
  args: ApproveCommandArgs,
  context: ApproveCommandContext
): Promise<ApproveCommandResult> {
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
  if (!canApprove(context, stage)) {
    return {
      success: false,
      message: `You do not have permission to approve stage "${stage.name}"`,
      errorCode: "PERMISSION_DENIED",
    };
  }

  // Process the approval
  const result = await ops.processApproval(
    state,
    pipeline.id,
    stage.id,
    "approve",
    {
      processedBy: context.userId,
      comment: args.comment,
    }
  );

  if (!result.ok) {
    return {
      success: false,
      message: `Failed to approve stage: ${result.error}`,
      errorCode: "APPROVAL_FAILED",
    };
  }

  // Build success message
  const commentPart = args.comment ? ` with comment: "${args.comment}"` : "";
  const message = `✅ Approved stage "${stage.name}" in pipeline "${pipeline.name}"${commentPart}`;

  return {
    success: true,
    message,
    pipeline,
    stage,
    approvalResult: {
      action: "approve",
      approvedBy: context.userId,
      timestampMs: Date.now(),
      comment: args.comment,
      success: true,
    },
  };
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Handles the /approve command.
 *
 * This is the main entry point for the approve command, combining parsing,
 * validation, and execution.
 *
 * @param state - Pipeline service state
 * @param rawArgs - Raw command arguments string
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function handleApproveCommand(
  state: PipelineServiceState,
  rawArgs: string,
  context: ApproveCommandContext
): Promise<ApproveCommandResult> {
  // Parse arguments
  const args = parseApproveArgs(rawArgs);
  if (!args) {
    return {
      success: false,
      message: "Usage: /approve <pipeline-id> <stage-id> [comment]",
      errorCode: "INVALID_ARGS",
    };
  }

  // Execute the approval
  return executeApprove(state, args, context);
}

// ============================================================================
// Help Text
// ============================================================================

/**
 * Returns the help text for the approve command.
 */
export function getApproveHelpText(): string {
  return `
/approve <pipeline-id> <stage-id> [comment]

Approve a pipeline stage that is awaiting approval.

Arguments:
  pipeline-id   The ID or name of the pipeline
  stage-id      The ID or name of the stage to approve
  comment       Optional comment explaining the approval decision

Examples:
  /approve abc123 build
  /approve "My Pipeline" "Build Stage"
  /approve abc123 build "Looks good, all tests passing"

Notes:
  - The stage must be in "awaiting_approval" status
  - You must have approval permissions for the stage
  - After approval, the pipeline will advance to the next stage
`.trim();
}

// ============================================================================
// Command Definition (for registry)
// ============================================================================

/**
 * Command definition for the approve command.
 * Can be used when registering with the command system.
 */
export const APPROVE_COMMAND_DEFINITION = {
  key: "approve",
  nativeName: "approve",
  description: "Approve a pipeline stage awaiting approval.",
  textAliases: ["/approve"],
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
      name: "comment",
      description: "Optional approval comment",
      type: "string" as const,
      captureRemaining: true,
    },
  ],
} as const;
