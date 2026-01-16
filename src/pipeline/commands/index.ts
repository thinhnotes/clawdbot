/**
 * Pipeline Commands Index
 *
 * Exports all pipeline commands and provides registration utilities for
 * integrating with the command system.
 *
 * Commands:
 * - /approve <pipeline-id> <stage-id> [comment] - Approve a pipeline stage
 * - /reject <pipeline-id> <stage-id> [reason] - Reject a pipeline stage
 * - /pipeline-status [pipeline-id] - View pipeline status and progress
 */

import type { PipelineServiceState } from "../state.js";
import type { ChatCommandDefinition } from "../../auto-reply/commands-registry.types.js";

// ============================================================================
// Re-export Individual Commands
// ============================================================================

// Approve command
export {
  handleApproveCommand,
  parseApproveArgs,
  executeApprove,
  canApprove,
  findPipeline as findPipelineForApprove,
  findStage as findStageForApprove,
  getApproveHelpText,
  APPROVE_COMMAND_DEFINITION,
} from "./approve.js";

export type {
  ApproveCommandContext,
  ApproveCommandArgs,
  ApproveCommandResult,
  ApproveErrorCode,
} from "./approve.js";

// Reject command
export {
  handleRejectCommand,
  parseRejectArgs,
  executeReject,
  canReject,
  findPipeline as findPipelineForReject,
  findStage as findStageForReject,
  getRejectHelpText,
  REJECT_COMMAND_DEFINITION,
} from "./reject.js";

export type {
  RejectCommandContext,
  RejectCommandArgs,
  RejectCommandResult,
  RejectErrorCode,
} from "./reject.js";

// Status command
export {
  handleStatusCommand,
  parseStatusArgs,
  executeStatus,
  executeListPipelines,
  executeGetPipelineStatus,
  findPipeline as findPipelineForStatus,
  getStatusHelpText,
  STATUS_COMMAND_DEFINITION,
} from "./status.js";

export type {
  StatusCommandContext,
  StatusCommandArgs,
  StatusCommandResult,
  StatusErrorCode,
  PipelineSummary,
  PipelineDetail,
  StageDetail,
} from "./status.js";

// ============================================================================
// Command Definitions
// ============================================================================

import {
  APPROVE_COMMAND_DEFINITION,
  handleApproveCommand,
  getApproveHelpText,
} from "./approve.js";

import {
  REJECT_COMMAND_DEFINITION,
  handleRejectCommand,
  getRejectHelpText,
} from "./reject.js";

import {
  STATUS_COMMAND_DEFINITION,
  handleStatusCommand,
  getStatusHelpText,
} from "./status.js";

/**
 * All pipeline command definitions for registry integration.
 *
 * These definitions follow the ChatCommandDefinition pattern and can be
 * added to the CHAT_COMMANDS array in commands-registry.data.ts.
 */
export const PIPELINE_COMMAND_DEFINITIONS = [
  {
    ...APPROVE_COMMAND_DEFINITION,
    scope: "both" as const,
  },
  {
    ...REJECT_COMMAND_DEFINITION,
    scope: "both" as const,
  },
  {
    ...STATUS_COMMAND_DEFINITION,
    scope: "both" as const,
  },
] as const;

/**
 * Pipeline command keys for quick lookup.
 */
export const PIPELINE_COMMAND_KEYS = {
  approve: "approve",
  reject: "reject",
  status: "pipeline-status",
} as const;

/**
 * Type for pipeline command keys.
 */
export type PipelineCommandKey = (typeof PIPELINE_COMMAND_KEYS)[keyof typeof PIPELINE_COMMAND_KEYS];

// ============================================================================
// Command Context Types
// ============================================================================

/**
 * Base context for all pipeline commands.
 */
export type PipelineCommandContext = {
  /** The user executing the command */
  userId: string;
  /** Whether the user is authorized for pipeline operations */
  isAuthorized: boolean;
  /** List of users with approval permissions (if configured) */
  approverList?: string[];
};

// ============================================================================
// Command Registry Integration
// ============================================================================

/**
 * Pipeline command handler type.
 */
export type PipelineCommandHandler = (
  state: PipelineServiceState,
  rawArgs: string,
  context: PipelineCommandContext
) => Promise<{ success: boolean; message: string }>;

/**
 * Map of command keys to their handlers.
 */
export const PIPELINE_COMMAND_HANDLERS: Record<PipelineCommandKey, PipelineCommandHandler> = {
  approve: handleApproveCommand,
  reject: handleRejectCommand,
  "pipeline-status": handleStatusCommand,
};

/**
 * Map of command keys to their help text functions.
 */
export const PIPELINE_COMMAND_HELP: Record<PipelineCommandKey, () => string> = {
  approve: getApproveHelpText,
  reject: getRejectHelpText,
  "pipeline-status": getStatusHelpText,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Gets a pipeline command handler by key.
 *
 * @param key - The command key
 * @returns The command handler or undefined if not found
 */
export function getPipelineCommandHandler(key: string): PipelineCommandHandler | undefined {
  return PIPELINE_COMMAND_HANDLERS[key as PipelineCommandKey];
}

/**
 * Gets the help text for a pipeline command.
 *
 * @param key - The command key
 * @returns The help text or undefined if not found
 */
export function getPipelineCommandHelpText(key: string): string | undefined {
  const getHelpText = PIPELINE_COMMAND_HELP[key as PipelineCommandKey];
  return getHelpText?.();
}

/**
 * Checks if a command key is a pipeline command.
 *
 * @param key - The command key to check
 * @returns Whether the key is a pipeline command
 */
export function isPipelineCommand(key: string): key is PipelineCommandKey {
  return key in PIPELINE_COMMAND_HANDLERS;
}

/**
 * Gets all pipeline command keys.
 *
 * @returns Array of pipeline command keys
 */
export function getPipelineCommandKeys(): PipelineCommandKey[] {
  return Object.keys(PIPELINE_COMMAND_HANDLERS) as PipelineCommandKey[];
}

/**
 * Gets the combined help text for all pipeline commands.
 *
 * @returns Combined help text for all pipeline commands
 */
export function getAllPipelineHelpText(): string {
  const sections = [
    "# Pipeline Commands",
    "",
    "Commands for managing multi-stage build pipelines with approval gates.",
    "",
    "## Available Commands",
    "",
    getApproveHelpText(),
    "",
    "---",
    "",
    getRejectHelpText(),
    "",
    "---",
    "",
    getStatusHelpText(),
  ];
  return sections.join("\n");
}

// ============================================================================
// Command Registration Helper
// ============================================================================

/**
 * Creates ChatCommandDefinition objects for pipeline commands.
 *
 * This helper transforms the raw command definitions into the format
 * expected by the command registry system.
 *
 * @returns Array of ChatCommandDefinition objects
 */
export function createPipelineCommandDefinitions(): ChatCommandDefinition[] {
  return [
    {
      key: APPROVE_COMMAND_DEFINITION.key,
      nativeName: APPROVE_COMMAND_DEFINITION.nativeName,
      description: APPROVE_COMMAND_DEFINITION.description,
      textAliases: [...APPROVE_COMMAND_DEFINITION.textAliases],
      acceptsArgs: APPROVE_COMMAND_DEFINITION.acceptsArgs,
      args: APPROVE_COMMAND_DEFINITION.args.map((arg) => ({
        name: arg.name,
        description: arg.description,
        type: arg.type,
        required: arg.required,
        captureRemaining: arg.captureRemaining,
      })),
      scope: "both",
    },
    {
      key: REJECT_COMMAND_DEFINITION.key,
      nativeName: REJECT_COMMAND_DEFINITION.nativeName,
      description: REJECT_COMMAND_DEFINITION.description,
      textAliases: [...REJECT_COMMAND_DEFINITION.textAliases],
      acceptsArgs: REJECT_COMMAND_DEFINITION.acceptsArgs,
      args: REJECT_COMMAND_DEFINITION.args.map((arg) => ({
        name: arg.name,
        description: arg.description,
        type: arg.type,
        required: arg.required,
        captureRemaining: arg.captureRemaining,
      })),
      scope: "both",
    },
    {
      key: STATUS_COMMAND_DEFINITION.key,
      nativeName: STATUS_COMMAND_DEFINITION.nativeName,
      description: STATUS_COMMAND_DEFINITION.description,
      textAliases: [...STATUS_COMMAND_DEFINITION.textAliases],
      acceptsArgs: STATUS_COMMAND_DEFINITION.acceptsArgs,
      args: STATUS_COMMAND_DEFINITION.args.map((arg) => ({
        name: arg.name,
        description: arg.description,
        type: arg.type,
      })),
      scope: "both",
    },
  ];
}

/**
 * Dispatches a pipeline command to the appropriate handler.
 *
 * @param state - Pipeline service state
 * @param commandKey - The command key (e.g., "approve", "reject", "pipeline-status")
 * @param rawArgs - Raw command arguments string
 * @param context - Command execution context
 * @returns Command execution result
 */
export async function dispatchPipelineCommand(
  state: PipelineServiceState,
  commandKey: string,
  rawArgs: string,
  context: PipelineCommandContext
): Promise<{ success: boolean; message: string }> {
  const handler = getPipelineCommandHandler(commandKey);

  if (!handler) {
    return {
      success: false,
      message: `Unknown pipeline command: ${commandKey}. Available commands: ${getPipelineCommandKeys().join(", ")}`,
    };
  }

  return handler(state, rawArgs, context);
}
