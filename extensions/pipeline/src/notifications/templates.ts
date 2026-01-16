/**
 * Notification Message Templates
 *
 * Provides message templates for different notification types. Templates support
 * both plain text and markdown variants for different notification channels.
 *
 * Features:
 * - Templates for all notification types (pipeline, stage, approval)
 * - Plain text and markdown message variants
 * - Contextual formatting with duration, branch, and metadata
 * - Consistent messaging across notification channels
 * - Template variable substitution
 *
 * @example
 * ```typescript
 * import {
 *   formatPipelineStarted,
 *   formatApprovalRequired,
 *   renderTemplate,
 * } from "./templates.js";
 *
 * // Format pipeline started notification
 * const { title, message, markdownMessage } = formatPipelineStarted({
 *   pipelineName: "build-and-deploy",
 *   sourceBranch: "main",
 *   triggeredBy: "john.doe",
 * });
 *
 * // Use with custom template
 * const customMessage = renderTemplate(
 *   "Pipeline {{pipelineName}} triggered by {{triggeredBy}}",
 *   { pipelineName: "ci", triggeredBy: "auto" }
 * );
 * ```
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  NotificationPriority,
  NotificationType,
  PipelineRun,
  Stage,
} from "../types.js";
import type { CreateNotificationInput } from "./hub.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Template output with plain text and markdown variants
 */
export interface TemplateOutput {
  /** Short title for the notification */
  title: string;
  /** Plain text message body */
  message: string;
  /** Markdown formatted message body */
  markdownMessage: string;
  /** Suggested notification priority */
  priority: NotificationPriority;
}

/**
 * Context for pipeline notifications
 */
export interface PipelineContext {
  /** Pipeline name */
  pipelineName: string;
  /** Pipeline run ID */
  runId?: string;
  /** Provider name */
  provider?: string;
  /** Source branch */
  sourceBranch?: string;
  /** Who triggered the pipeline */
  triggeredBy?: string;
  /** Web URL to view the pipeline */
  webUrl?: string;
  /** Commit SHA */
  commitId?: string;
  /** Commit message */
  commitMessage?: string;
  /** Pipeline result */
  result?: "succeeded" | "failed" | "cancelled";
  /** Duration in milliseconds */
  durationMs?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Context for stage notifications
 */
export interface StageContext extends PipelineContext {
  /** Stage ID */
  stageId: string;
  /** Stage name */
  stageName: string;
  /** Stage result */
  stageResult?: "succeeded" | "failed" | "cancelled" | "skipped";
}

/**
 * Context for approval notifications
 */
export interface ApprovalContext extends StageContext {
  /** Approval ID */
  approvalId: string;
  /** Allowed approvers */
  approvers?: string[];
  /** Approval instructions */
  instructions?: string;
  /** Approval expiration time */
  expiresAt?: number;
  /** Approval decision */
  decision?: "approve" | "reject";
  /** Who approved/rejected */
  approvedBy?: string;
  /** Comment on the decision */
  comment?: string;
}

/**
 * Template variable mapping
 */
export type TemplateVariables = Record<string, string | number | boolean | undefined>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Result emoji mapping */
const RESULT_EMOJI: Record<string, string> = {
  succeeded: "✅",
  failed: "❌",
  cancelled: "⚠️",
  skipped: "⏭️",
};

/** Notification type emoji */
const TYPE_EMOJI: Record<NotificationType, string> = {
  pipeline_started: "🚀",
  pipeline_completed: "✅",
  pipeline_failed: "❌",
  stage_started: "▶️",
  stage_completed: "✅",
  stage_failed: "❌",
  approval_required: "✋",
  approval_completed: "✅",
};

// -----------------------------------------------------------------------------
// Template Rendering
// -----------------------------------------------------------------------------

/**
 * Render a template string with variable substitution
 *
 * Replaces {{variable}} placeholders with corresponding values from the
 * variables object. Missing variables are replaced with empty string.
 *
 * @param template - Template string with {{variable}} placeholders
 * @param variables - Variable values to substitute
 * @returns Rendered template string
 *
 * @example
 * ```typescript
 * const result = renderTemplate(
 *   "Pipeline {{name}} on branch {{branch}}",
 *   { name: "build", branch: "main" }
 * );
 * // Returns: "Pipeline build on branch main"
 * ```
 */
export function renderTemplate(
  template: string,
  variables: TemplateVariables
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

/**
 * Escape markdown special characters
 *
 * @param text - Text to escape
 * @returns Escaped text safe for markdown
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[*_`[\]()#\\]/g, "\\$&");
}

/**
 * Format duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "2m 30s", "1h 15m")
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format relative time from now
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Relative time string (e.g., "in 5 minutes", "2 hours ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  let timeStr: string;
  if (hours > 0) {
    timeStr = `${hours} hour${hours === 1 ? "" : "s"}`;
  } else if (minutes > 0) {
    timeStr = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  } else {
    timeStr = `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return diff > 0 ? `in ${timeStr}` : `${timeStr} ago`;
}

/**
 * Truncate a string to maximum length with ellipsis
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (default: 100)
 * @returns Truncated text with ellipsis if needed
 */
export function truncate(text: string, maxLength = 100): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

// -----------------------------------------------------------------------------
// Pipeline Templates
// -----------------------------------------------------------------------------

/**
 * Format pipeline started notification
 *
 * @param context - Pipeline context
 * @returns Template output with title, message, and markdown
 */
export function formatPipelineStarted(context: PipelineContext): TemplateOutput {
  const { pipelineName, sourceBranch, triggeredBy, provider } = context;

  const title = "Pipeline Started";

  let message = `Pipeline "${pipelineName}" has started.`;
  let markdownMessage = `Pipeline **"${pipelineName}"** has started.`;

  const details: string[] = [];
  const markdownDetails: string[] = [];

  if (sourceBranch) {
    details.push(`Branch: ${sourceBranch}`);
    markdownDetails.push(`Branch: \`${sourceBranch}\``);
  }

  if (triggeredBy) {
    details.push(`Triggered by: ${triggeredBy}`);
    markdownDetails.push(`Triggered by: ${triggeredBy}`);
  }

  if (provider) {
    details.push(`Provider: ${provider}`);
    markdownDetails.push(`Provider: ${provider}`);
  }

  if (details.length > 0) {
    message += `\n${details.join(" | ")}`;
    markdownMessage += `\n\n${markdownDetails.join(" | ")}`;
  }

  return {
    title,
    message,
    markdownMessage,
    priority: "low",
  };
}

/**
 * Format pipeline completed notification
 *
 * @param context - Pipeline context with result
 * @returns Template output with title, message, and markdown
 */
export function formatPipelineCompleted(context: PipelineContext): TemplateOutput {
  const { pipelineName, result, durationMs, webUrl, error } = context;

  const emoji = RESULT_EMOJI[result ?? "succeeded"] ?? "";
  const resultText = result ?? "completed";
  const isSuccess = result === "succeeded";
  const isFailed = result === "failed";

  const title = `Pipeline ${isSuccess ? "Succeeded" : isFailed ? "Failed" : "Completed"}`;

  let message = `${emoji} Pipeline "${pipelineName}" ${resultText}.`;
  let markdownMessage = `${emoji} Pipeline **"${pipelineName}"** ${resultText}.`;

  if (durationMs) {
    const duration = formatDuration(durationMs);
    message += ` Duration: ${duration}`;
    markdownMessage += `\n\nDuration: ${duration}`;
  }

  if (error && isFailed) {
    const truncatedError = truncate(error, 200);
    message += `\nError: ${truncatedError}`;
    markdownMessage += `\n\n> ${truncatedError}`;
  }

  if (webUrl) {
    message += `\nView: ${webUrl}`;
    markdownMessage += `\n\n[View Details](${webUrl})`;
  }

  return {
    title,
    message,
    markdownMessage,
    priority: isFailed ? "high" : "normal",
  };
}

/**
 * Format pipeline failed notification
 *
 * @param context - Pipeline context with error
 * @returns Template output with title, message, and markdown
 */
export function formatPipelineFailed(context: PipelineContext): TemplateOutput {
  return formatPipelineCompleted({ ...context, result: "failed" });
}

// -----------------------------------------------------------------------------
// Stage Templates
// -----------------------------------------------------------------------------

/**
 * Format stage started notification
 *
 * @param context - Stage context
 * @returns Template output with title, message, and markdown
 */
export function formatStageStarted(context: StageContext): TemplateOutput {
  const { stageName, pipelineName } = context;

  const title = "Stage Started";
  const message = `Stage "${stageName}" in pipeline "${pipelineName}" has started.`;
  const markdownMessage = `Stage **"${stageName}"** in pipeline **"${pipelineName}"** has started.`;

  return {
    title,
    message,
    markdownMessage,
    priority: "low",
  };
}

/**
 * Format stage completed notification
 *
 * @param context - Stage context with result
 * @returns Template output with title, message, and markdown
 */
export function formatStageCompleted(context: StageContext): TemplateOutput {
  const { stageName, pipelineName, stageResult, durationMs, error } = context;

  const emoji = RESULT_EMOJI[stageResult ?? "succeeded"] ?? "";
  const resultText = stageResult ?? "completed";
  const isSuccess = stageResult === "succeeded";
  const isFailed = stageResult === "failed";

  const title = `Stage ${isSuccess ? "Succeeded" : isFailed ? "Failed" : "Completed"}`;

  let message = `${emoji} Stage "${stageName}" in pipeline "${pipelineName}" ${resultText}.`;
  let markdownMessage = `${emoji} Stage **"${stageName}"** in pipeline **"${pipelineName}"** ${resultText}.`;

  if (durationMs) {
    const duration = formatDuration(durationMs);
    message += ` Duration: ${duration}`;
    markdownMessage += `\n\nDuration: ${duration}`;
  }

  if (error && isFailed) {
    const truncatedError = truncate(error, 200);
    message += `\nError: ${truncatedError}`;
    markdownMessage += `\n\n> ${truncatedError}`;
  }

  return {
    title,
    message,
    markdownMessage,
    priority: isFailed ? "high" : "normal",
  };
}

/**
 * Format stage failed notification
 *
 * @param context - Stage context with error
 * @returns Template output with title, message, and markdown
 */
export function formatStageFailed(context: StageContext): TemplateOutput {
  return formatStageCompleted({ ...context, stageResult: "failed" });
}

// -----------------------------------------------------------------------------
// Approval Templates
// -----------------------------------------------------------------------------

/**
 * Format approval required notification
 *
 * @param context - Approval context
 * @returns Template output with title, message, and markdown
 */
export function formatApprovalRequired(context: ApprovalContext): TemplateOutput {
  const { stageName, pipelineName, approvers, instructions, expiresAt } = context;

  const title = "Approval Required";

  let message = `Stage "${stageName}" in pipeline "${pipelineName}" requires approval.`;
  let markdownMessage = `**Stage "${stageName}"** in pipeline **"${pipelineName}"** requires approval.`;

  if (instructions) {
    message += `\n\nInstructions: ${instructions}`;
    markdownMessage += `\n\n${instructions}`;
  }

  if (approvers && approvers.length > 0) {
    const approverList = approvers.join(", ");
    message += `\n\nApprovers: ${approverList}`;
    markdownMessage += `\n\nApprovers: ${approverList}`;
  }

  if (expiresAt) {
    const expiresIn = formatRelativeTime(expiresAt);
    message += `\nExpires: ${expiresIn}`;
    markdownMessage += `\nExpires: ${expiresIn}`;
  }

  return {
    title,
    message,
    markdownMessage,
    priority: "high",
  };
}

/**
 * Format approval completed notification
 *
 * @param context - Approval context with decision
 * @returns Template output with title, message, and markdown
 */
export function formatApprovalCompleted(context: ApprovalContext): TemplateOutput {
  const { stageName, pipelineName, decision, approvedBy, comment } = context;

  const isApproved = decision === "approve";
  const decisionText = isApproved ? "approved" : "rejected";
  const emoji = isApproved ? "✅" : "❌";

  const title = `Stage ${isApproved ? "Approved" : "Rejected"}`;

  let message = `${emoji} Stage "${stageName}" in pipeline "${pipelineName}" was ${decisionText}`;
  let markdownMessage = `${emoji} Stage **"${stageName}"** in pipeline **"${pipelineName}"** was ${decisionText}`;

  if (approvedBy) {
    message += ` by ${approvedBy}`;
    markdownMessage += ` by **${approvedBy}**`;
  }

  message += ".";
  markdownMessage += ".";

  if (comment) {
    message += `\n\nComment: ${comment}`;
    markdownMessage += `\n\n> ${comment}`;
  }

  return {
    title,
    message,
    markdownMessage,
    priority: "normal",
  };
}

/**
 * Format approval timeout notification
 *
 * @param context - Approval context
 * @returns Template output with title, message, and markdown
 */
export function formatApprovalTimeout(context: ApprovalContext): TemplateOutput {
  const { stageName, pipelineName } = context;

  const title = "Approval Timeout";
  const message = `⏰ Stage "${stageName}" in pipeline "${pipelineName}" approval request has timed out.`;
  const markdownMessage = `⏰ Stage **"${stageName}"** in pipeline **"${pipelineName}"** approval request has **timed out**.`;

  return {
    title,
    message,
    markdownMessage,
    priority: "high",
  };
}

// -----------------------------------------------------------------------------
// Notification Input Formatters
// -----------------------------------------------------------------------------

/**
 * Create notification input from a pipeline run for pipeline started event
 *
 * @param run - Pipeline run
 * @returns CreateNotificationInput for the hub
 */
export function createPipelineStartedInput(run: PipelineRun): CreateNotificationInput {
  const template = formatPipelineStarted({
    pipelineName: run.pipelineName,
    runId: run.id,
    provider: run.provider,
    sourceBranch: run.sourceBranch,
    triggeredBy: run.triggeredBy,
    webUrl: run.webUrl,
    commitId: run.commitId,
    commitMessage: run.commitMessage,
  });

  return {
    type: "pipeline_started",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: run.id,
    webUrl: run.webUrl,
    metadata: {
      pipelineId: run.pipelineId,
      provider: run.provider,
      sourceBranch: run.sourceBranch,
      triggeredBy: run.triggeredBy,
    },
  };
}

/**
 * Create notification input from a pipeline run for pipeline completed event
 *
 * @param run - Pipeline run
 * @returns CreateNotificationInput for the hub
 */
export function createPipelineCompletedInput(run: PipelineRun): CreateNotificationInput {
  const isFailed = run.result === "failed";

  const template = formatPipelineCompleted({
    pipelineName: run.pipelineName,
    runId: run.id,
    provider: run.provider,
    result: run.result,
    durationMs: run.durationMs,
    webUrl: run.webUrl,
  });

  return {
    type: isFailed ? "pipeline_failed" : "pipeline_completed",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: run.id,
    webUrl: run.webUrl,
    metadata: {
      pipelineId: run.pipelineId,
      provider: run.provider,
      result: run.result,
      durationMs: run.durationMs,
    },
  };
}

/**
 * Create notification input from a pipeline run and stage for stage started event
 *
 * @param run - Pipeline run
 * @param stage - Stage that started
 * @returns CreateNotificationInput for the hub
 */
export function createStageStartedInput(
  run: PipelineRun,
  stage: Stage
): CreateNotificationInput {
  const template = formatStageStarted({
    stageName: stage.name,
    stageId: stage.id,
    pipelineName: run.pipelineName,
    runId: run.id,
    provider: run.provider,
  });

  return {
    type: "stage_started",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: run.id,
    stageId: stage.id,
    webUrl: run.webUrl,
    metadata: {
      pipelineId: run.pipelineId,
      provider: run.provider,
      stageOrder: stage.order,
    },
  };
}

/**
 * Create notification input from a pipeline run and stage for stage completed event
 *
 * @param run - Pipeline run
 * @param stage - Stage that completed
 * @returns CreateNotificationInput for the hub
 */
export function createStageCompletedInput(
  run: PipelineRun,
  stage: Stage
): CreateNotificationInput {
  const isFailed = stage.result === "failed";

  const template = formatStageCompleted({
    stageName: stage.name,
    stageId: stage.id,
    pipelineName: run.pipelineName,
    runId: run.id,
    provider: run.provider,
    stageResult: stage.result,
    durationMs: stage.durationMs,
    error: stage.error,
  });

  return {
    type: isFailed ? "stage_failed" : "stage_completed",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: run.id,
    stageId: stage.id,
    webUrl: run.webUrl,
    metadata: {
      pipelineId: run.pipelineId,
      provider: run.provider,
      stageResult: stage.result,
      durationMs: stage.durationMs,
      error: stage.error,
    },
  };
}

/**
 * Create notification input from an approval request
 *
 * @param approval - Approval request
 * @returns CreateNotificationInput for the hub
 */
export function createApprovalRequiredInput(
  approval: ApprovalRequest
): CreateNotificationInput {
  const template = formatApprovalRequired({
    stageName: approval.stageName,
    stageId: approval.stageId,
    pipelineName: approval.pipelineName,
    runId: approval.runId,
    approvalId: approval.id,
    approvers: approval.approvers,
    instructions: approval.instructions,
    expiresAt: approval.expiresAt,
  });

  return {
    type: "approval_required",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: approval.runId,
    stageId: approval.stageId,
    approvalId: approval.id,
    actions: [
      {
        id: "approve",
        label: "Approve",
        style: "success",
      },
      {
        id: "reject",
        label: "Reject",
        style: "danger",
      },
    ],
    metadata: {
      approvers: approval.approvers,
      expiresAt: approval.expiresAt,
      providerApprovalId: approval.providerApprovalId,
    },
  };
}

/**
 * Create notification input from an approval request and response
 *
 * @param approval - Approval request
 * @param response - Approval response
 * @returns CreateNotificationInput for the hub
 */
export function createApprovalCompletedInput(
  approval: ApprovalRequest,
  response: ApprovalResponse
): CreateNotificationInput {
  const template = formatApprovalCompleted({
    stageName: approval.stageName,
    stageId: approval.stageId,
    pipelineName: approval.pipelineName,
    runId: approval.runId,
    approvalId: approval.id,
    decision: response.decision,
    approvedBy: response.approvedBy,
    comment: response.comment,
  });

  return {
    type: "approval_completed",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: approval.runId,
    stageId: approval.stageId,
    approvalId: approval.id,
    metadata: {
      decision: response.decision,
      approvedBy: response.approvedBy,
      approvedAt: response.approvedAt,
    },
  };
}

/**
 * Create notification input from an approval request for timeout
 *
 * @param approval - Approval request that timed out
 * @returns CreateNotificationInput for the hub
 */
export function createApprovalTimeoutInput(
  approval: ApprovalRequest
): CreateNotificationInput {
  const template = formatApprovalTimeout({
    stageName: approval.stageName,
    stageId: approval.stageId,
    pipelineName: approval.pipelineName,
    runId: approval.runId,
    approvalId: approval.id,
  });

  return {
    type: "stage_failed",
    priority: template.priority,
    title: template.title,
    message: template.message,
    markdownMessage: template.markdownMessage,
    runId: approval.runId,
    stageId: approval.stageId,
    approvalId: approval.id,
    metadata: {
      reason: "timeout",
      expiresAt: approval.expiresAt,
    },
  };
}

// -----------------------------------------------------------------------------
// Template Registry
// -----------------------------------------------------------------------------

/**
 * Template formatter function type
 */
type TemplateFormatter<T> = (context: T) => TemplateOutput;

/**
 * Registry of template formatters by notification type
 */
export const templateFormatters: Record<
  NotificationType,
  TemplateFormatter<PipelineContext | StageContext | ApprovalContext>
> = {
  pipeline_started: formatPipelineStarted,
  pipeline_completed: formatPipelineCompleted,
  pipeline_failed: formatPipelineFailed,
  stage_started: formatStageStarted as TemplateFormatter<PipelineContext | StageContext | ApprovalContext>,
  stage_completed: formatStageCompleted as TemplateFormatter<PipelineContext | StageContext | ApprovalContext>,
  stage_failed: formatStageFailed as TemplateFormatter<PipelineContext | StageContext | ApprovalContext>,
  approval_required: formatApprovalRequired as TemplateFormatter<PipelineContext | StageContext | ApprovalContext>,
  approval_completed: formatApprovalCompleted as TemplateFormatter<PipelineContext | StageContext | ApprovalContext>,
};

/**
 * Get the emoji for a notification type
 *
 * @param type - Notification type
 * @returns Emoji string for the type
 */
export function getNotificationEmoji(type: NotificationType): string {
  return TYPE_EMOJI[type] ?? "📢";
}

/**
 * Get the emoji for a result
 *
 * @param result - Result string
 * @returns Emoji string for the result
 */
export function getResultEmoji(
  result: "succeeded" | "failed" | "cancelled" | "skipped"
): string {
  return RESULT_EMOJI[result] ?? "";
}
