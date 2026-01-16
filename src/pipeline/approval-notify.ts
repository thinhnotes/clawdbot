/**
 * Approval Notification Dispatcher
 *
 * This module handles sending notifications for pipeline approval events.
 * It supports multiple notification channels: Discord, Slack, Telegram, and native push.
 */

import type {
  ApprovalNotification,
  ApprovalNotificationAction,
  ApprovalNotificationChannel,
  ApprovalNotificationType,
  ApprovalQueueEntry,
  ApprovalResult,
} from "./approval-types.js";
import type { NotificationHandler, PipelineServiceState } from "./state.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Notification dispatch result for a single channel.
 */
export type NotificationDispatchResult = {
  channel: ApprovalNotificationChannel;
  recipient: string;
  success: boolean;
  notificationId: string;
  error?: string;
};

/**
 * Result of sending notifications to multiple channels.
 */
export type NotificationBroadcastResult = {
  /** Total notifications attempted */
  attempted: number;
  /** Successfully delivered */
  delivered: number;
  /** Failed deliveries */
  failed: number;
  /** Individual results per channel */
  results: NotificationDispatchResult[];
};

/**
 * Options for approval required notification.
 */
export type NotifyApprovalRequiredOptions = {
  /** Pipeline ID */
  pipelineId: string;
  /** Stage ID */
  stageId: string;
  /** Pipeline name for display */
  pipelineName: string;
  /** Stage name for display */
  stageName: string;
  /** Who requested the approval */
  requestedBy?: string;
  /** Time until expiry (ms) */
  expiresInMs?: number;
  /** Custom message to include */
  customMessage?: string;
};

/**
 * Options for approval processed notification.
 */
export type NotifyApprovalProcessedOptions = {
  /** Pipeline ID */
  pipelineId: string;
  /** Stage ID */
  stageId: string;
  /** Pipeline name for display */
  pipelineName: string;
  /** Stage name for display */
  stageName: string;
  /** The approval result */
  result: ApprovalResult;
};

/**
 * Notification channel configuration.
 */
export type NotificationChannelConfig = {
  /** Channel type */
  channel: ApprovalNotificationChannel;
  /** Recipient identifier (channel ID, user ID, chat ID, etc.) */
  recipient: string;
  /** Whether this channel is enabled */
  enabled: boolean;
};

// ============================================================================
// Notification ID Generation
// ============================================================================

let notificationIdCounter = 0;

/**
 * Generates a unique notification ID.
 */
function generateNotificationId(): string {
  notificationIdCounter++;
  return `notify-${Date.now()}-${notificationIdCounter}`;
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 60000) {
    return `${Math.ceil(ms / 1000)} seconds`;
  }
  if (ms < 3600000) {
    const minutes = Math.ceil(ms / 60000);
    return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
  const hours = Math.ceil(ms / 3600000);
  return `${hours} hour${hours !== 1 ? "s" : ""}`;
}

/**
 * Builds the title for an approval required notification.
 */
function buildApprovalRequiredTitle(
  pipelineName: string,
  stageName: string
): string {
  return `🔔 Approval Required: ${pipelineName} - ${stageName}`;
}

/**
 * Builds the body for an approval required notification.
 */
function buildApprovalRequiredBody(opts: NotifyApprovalRequiredOptions): string {
  const lines: string[] = [];

  lines.push(`Pipeline **${opts.pipelineName}** is awaiting approval for stage **${opts.stageName}**.`);
  lines.push("");

  if (opts.requestedBy) {
    lines.push(`Requested by: ${opts.requestedBy}`);
  }

  if (opts.expiresInMs !== undefined && opts.expiresInMs > 0) {
    lines.push(`Expires in: ${formatDuration(opts.expiresInMs)}`);
  }

  if (opts.customMessage) {
    lines.push("");
    lines.push(opts.customMessage);
  }

  lines.push("");
  lines.push("Use the commands below to approve or reject this stage:");
  lines.push(`• \`/approve ${opts.pipelineId} ${opts.stageId}\``);
  lines.push(`• \`/reject ${opts.pipelineId} ${opts.stageId}\``);

  return lines.join("\n");
}

/**
 * Builds the title for an approval processed notification.
 */
function buildApprovalProcessedTitle(
  pipelineName: string,
  stageName: string,
  action: "approve" | "reject"
): string {
  const emoji = action === "approve" ? "✅" : "❌";
  const verb = action === "approve" ? "Approved" : "Rejected";
  return `${emoji} ${verb}: ${pipelineName} - ${stageName}`;
}

/**
 * Builds the body for an approval processed notification.
 */
function buildApprovalProcessedBody(opts: NotifyApprovalProcessedOptions): string {
  const lines: string[] = [];
  const { result } = opts;

  const verb = result.action === "approve" ? "approved" : "rejected";
  lines.push(
    `Stage **${opts.stageName}** of pipeline **${opts.pipelineName}** has been ${verb}.`
  );
  lines.push("");

  lines.push(`Processed by: ${result.approvedBy}`);
  lines.push(`Time: ${new Date(result.timestampMs).toISOString()}`);

  if (result.comment) {
    lines.push("");
    lines.push(`Comment: ${result.comment}`);
  }

  if (!result.success && result.error) {
    lines.push("");
    lines.push(`⚠️ Error: ${result.error}`);
  }

  return lines.join("\n");
}

/**
 * Builds action buttons for an approval required notification.
 */
function buildApprovalRequiredActions(
  pipelineId: string,
  stageId: string
): ApprovalNotificationAction[] {
  return [
    {
      label: "Approve",
      action: "approve",
      command: `/approve ${pipelineId} ${stageId}`,
    },
    {
      label: "Reject",
      action: "reject",
      command: `/reject ${pipelineId} ${stageId}`,
    },
    {
      label: "View Status",
      action: "view",
      command: `/pipeline-status ${pipelineId}`,
    },
  ];
}

/**
 * Builds action buttons for an approval processed notification.
 */
function buildApprovalProcessedActions(
  pipelineId: string
): ApprovalNotificationAction[] {
  return [
    {
      label: "View Pipeline",
      action: "view",
      command: `/pipeline-status ${pipelineId}`,
    },
  ];
}

// ============================================================================
// Notification Building
// ============================================================================

/**
 * Creates an approval notification object.
 */
function createApprovalNotification(params: {
  type: ApprovalNotificationType;
  channel: ApprovalNotificationChannel;
  recipient: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  title: string;
  body: string;
  actions?: ApprovalNotificationAction[];
  nowMs: number;
}): ApprovalNotification {
  return {
    id: generateNotificationId(),
    type: params.type,
    channel: params.channel,
    recipient: params.recipient,
    pipelineId: params.pipelineId,
    pipelineName: params.pipelineName,
    stageId: params.stageId,
    stageName: params.stageName,
    title: params.title,
    body: params.body,
    actions: params.actions,
    createdAtMs: params.nowMs,
  };
}

// ============================================================================
// Channel Resolution
// ============================================================================

/**
 * Resolves notification channels from pipeline configuration.
 * Parses channel strings in format "channel:recipient" (e.g., "discord:123456789").
 */
export function resolveNotificationChannels(
  channelStrings?: string[]
): NotificationChannelConfig[] {
  if (!channelStrings || channelStrings.length === 0) {
    return [];
  }

  const configs: NotificationChannelConfig[] = [];

  for (const str of channelStrings) {
    const [channelType, ...recipientParts] = str.split(":");
    const recipient = recipientParts.join(":");

    if (!channelType || !recipient) {
      continue;
    }

    const channel = channelType.toLowerCase() as ApprovalNotificationChannel;

    // Validate channel type
    if (!["discord", "slack", "telegram", "push"].includes(channel)) {
      continue;
    }

    configs.push({
      channel,
      recipient,
      enabled: true,
    });
  }

  return configs;
}

// ============================================================================
// Notification Dispatch
// ============================================================================

/**
 * Dispatches a notification through the configured notification handler.
 */
async function dispatchNotification(
  notification: ApprovalNotification,
  sendNotification?: NotificationHandler
): Promise<NotificationDispatchResult> {
  if (!sendNotification) {
    return {
      channel: notification.channel,
      recipient: notification.recipient,
      success: false,
      notificationId: notification.id,
      error: "No notification handler configured",
    };
  }

  try {
    const delivered = await sendNotification(notification);

    return {
      channel: notification.channel,
      recipient: notification.recipient,
      success: delivered,
      notificationId: notification.id,
      error: delivered ? undefined : "Notification delivery failed",
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      channel: notification.channel,
      recipient: notification.recipient,
      success: false,
      notificationId: notification.id,
      error: errorMessage,
    };
  }
}

/**
 * Broadcasts notifications to multiple channels.
 */
async function broadcastNotifications(
  notifications: ApprovalNotification[],
  sendNotification?: NotificationHandler
): Promise<NotificationBroadcastResult> {
  const results: NotificationDispatchResult[] = [];

  // Send notifications in parallel
  const dispatchPromises = notifications.map((notification) =>
    dispatchNotification(notification, sendNotification)
  );

  const dispatchResults = await Promise.all(dispatchPromises);
  results.push(...dispatchResults);

  const delivered = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    attempted: results.length,
    delivered,
    failed,
    results,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Sends notifications when an approval is required.
 * Broadcasts to all configured notification channels for the pipeline.
 *
 * @param state - Pipeline service state
 * @param opts - Notification options including pipeline/stage info
 * @returns Broadcast result with delivery status per channel
 */
export async function notifyApprovalRequired(
  state: PipelineServiceState,
  opts: NotifyApprovalRequiredOptions
): Promise<NotificationBroadcastResult> {
  const { deps } = state;
  const nowMs = deps.nowMs();

  // Get the pipeline to access notification channels config
  const pipeline = state.store?.pipelines.find((p) => p.id === opts.pipelineId);
  const channels = resolveNotificationChannels(pipeline?.config.notificationChannels);

  if (channels.length === 0) {
    deps.log.debug(
      { pipelineId: opts.pipelineId, stageId: opts.stageId },
      "No notification channels configured for pipeline"
    );
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      results: [],
    };
  }

  // Build notification for each channel
  const notifications: ApprovalNotification[] = channels
    .filter((c) => c.enabled)
    .map((config) =>
      createApprovalNotification({
        type: "approval_required",
        channel: config.channel,
        recipient: config.recipient,
        pipelineId: opts.pipelineId,
        pipelineName: opts.pipelineName,
        stageId: opts.stageId,
        stageName: opts.stageName,
        title: buildApprovalRequiredTitle(opts.pipelineName, opts.stageName),
        body: buildApprovalRequiredBody(opts),
        actions: buildApprovalRequiredActions(opts.pipelineId, opts.stageId),
        nowMs,
      })
    );

  deps.log.info(
    {
      pipelineId: opts.pipelineId,
      stageId: opts.stageId,
      channelCount: notifications.length,
    },
    "Sending approval required notifications"
  );

  const result = await broadcastNotifications(notifications, deps.sendNotification);

  if (result.failed > 0) {
    deps.log.warn(
      {
        pipelineId: opts.pipelineId,
        stageId: opts.stageId,
        delivered: result.delivered,
        failed: result.failed,
      },
      "Some approval notifications failed to send"
    );
  }

  return result;
}

/**
 * Sends notifications when an approval has been processed (approved or rejected).
 * Broadcasts to all configured notification channels for the pipeline.
 *
 * @param state - Pipeline service state
 * @param opts - Notification options including pipeline/stage info and result
 * @returns Broadcast result with delivery status per channel
 */
export async function notifyApprovalProcessed(
  state: PipelineServiceState,
  opts: NotifyApprovalProcessedOptions
): Promise<NotificationBroadcastResult> {
  const { deps } = state;
  const nowMs = deps.nowMs();

  // Get the pipeline to access notification channels config
  const pipeline = state.store?.pipelines.find((p) => p.id === opts.pipelineId);
  const channels = resolveNotificationChannels(pipeline?.config.notificationChannels);

  if (channels.length === 0) {
    deps.log.debug(
      { pipelineId: opts.pipelineId, stageId: opts.stageId },
      "No notification channels configured for pipeline"
    );
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      results: [],
    };
  }

  // Build notification for each channel
  const notifications: ApprovalNotification[] = channels
    .filter((c) => c.enabled)
    .map((config) =>
      createApprovalNotification({
        type: "approval_processed",
        channel: config.channel,
        recipient: config.recipient,
        pipelineId: opts.pipelineId,
        pipelineName: opts.pipelineName,
        stageId: opts.stageId,
        stageName: opts.stageName,
        title: buildApprovalProcessedTitle(
          opts.pipelineName,
          opts.stageName,
          opts.result.action
        ),
        body: buildApprovalProcessedBody(opts),
        actions: buildApprovalProcessedActions(opts.pipelineId),
        nowMs,
      })
    );

  deps.log.info(
    {
      pipelineId: opts.pipelineId,
      stageId: opts.stageId,
      action: opts.result.action,
      channelCount: notifications.length,
    },
    "Sending approval processed notifications"
  );

  const result = await broadcastNotifications(notifications, deps.sendNotification);

  if (result.failed > 0) {
    deps.log.warn(
      {
        pipelineId: opts.pipelineId,
        stageId: opts.stageId,
        delivered: result.delivered,
        failed: result.failed,
      },
      "Some approval processed notifications failed to send"
    );
  }

  return result;
}

/**
 * Sends a notification for an approval timeout event.
 *
 * @param state - Pipeline service state
 * @param entry - The approval queue entry that timed out
 * @returns Broadcast result with delivery status per channel
 */
export async function notifyApprovalTimeout(
  state: PipelineServiceState,
  entry: ApprovalQueueEntry
): Promise<NotificationBroadcastResult> {
  const { deps } = state;
  const nowMs = deps.nowMs();

  const channels = resolveNotificationChannels(
    entry.pipeline.config.notificationChannels
  );

  if (channels.length === 0) {
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      results: [],
    };
  }

  const notifications: ApprovalNotification[] = channels
    .filter((c) => c.enabled)
    .map((config) =>
      createApprovalNotification({
        type: "approval_timeout",
        channel: config.channel,
        recipient: config.recipient,
        pipelineId: entry.pipeline.id,
        pipelineName: entry.pipeline.name,
        stageId: entry.stage.id,
        stageName: entry.stage.name,
        title: `⏰ Approval Timeout: ${entry.pipeline.name} - ${entry.stage.name}`,
        body: `The approval request for stage **${entry.stage.name}** of pipeline **${entry.pipeline.name}** has timed out.`,
        actions: buildApprovalProcessedActions(entry.pipeline.id),
        nowMs,
      })
    );

  deps.log.info(
    {
      pipelineId: entry.pipeline.id,
      stageId: entry.stage.id,
      channelCount: notifications.length,
    },
    "Sending approval timeout notifications"
  );

  return await broadcastNotifications(notifications, deps.sendNotification);
}

/**
 * Sends a reminder notification for a pending approval.
 *
 * @param state - Pipeline service state
 * @param entry - The approval queue entry to remind about
 * @param timeRemainingMs - Time remaining before expiry
 * @returns Broadcast result with delivery status per channel
 */
export async function notifyApprovalReminder(
  state: PipelineServiceState,
  entry: ApprovalQueueEntry,
  timeRemainingMs: number
): Promise<NotificationBroadcastResult> {
  const { deps } = state;
  const nowMs = deps.nowMs();

  const channels = resolveNotificationChannels(
    entry.pipeline.config.notificationChannels
  );

  if (channels.length === 0) {
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      results: [],
    };
  }

  const notifications: ApprovalNotification[] = channels
    .filter((c) => c.enabled)
    .map((config) =>
      createApprovalNotification({
        type: "approval_reminder",
        channel: config.channel,
        recipient: config.recipient,
        pipelineId: entry.pipeline.id,
        pipelineName: entry.pipeline.name,
        stageId: entry.stage.id,
        stageName: entry.stage.name,
        title: `⏳ Approval Reminder: ${entry.pipeline.name} - ${entry.stage.name}`,
        body: [
          `Reminder: Stage **${entry.stage.name}** of pipeline **${entry.pipeline.name}** is still awaiting approval.`,
          "",
          `Time remaining: ${formatDuration(timeRemainingMs)}`,
          "",
          "Use the commands below to approve or reject this stage:",
          `• \`/approve ${entry.pipeline.id} ${entry.stage.id}\``,
          `• \`/reject ${entry.pipeline.id} ${entry.stage.id}\``,
        ].join("\n"),
        actions: buildApprovalRequiredActions(entry.pipeline.id, entry.stage.id),
        nowMs,
      })
    );

  deps.log.info(
    {
      pipelineId: entry.pipeline.id,
      stageId: entry.stage.id,
      timeRemainingMs,
      channelCount: notifications.length,
    },
    "Sending approval reminder notifications"
  );

  return await broadcastNotifications(notifications, deps.sendNotification);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Creates a notification handler that logs to console (useful for testing).
 */
export function createConsoleNotificationHandler(): NotificationHandler {
  return async (notification: ApprovalNotification): Promise<boolean> => {
    const logEntry = {
      id: notification.id,
      type: notification.type,
      channel: notification.channel,
      recipient: notification.recipient,
      title: notification.title,
      pipelineId: notification.pipelineId,
      stageId: notification.stageId,
    };

    // eslint-disable-next-line no-console
    console.log("[ApprovalNotify]", JSON.stringify(logEntry, null, 2));

    return true;
  };
}

/**
 * Notifies about an approval request from a queue entry.
 * Convenience function that extracts relevant info from ApprovalQueueEntry.
 */
export async function notifyFromQueueEntry(
  state: PipelineServiceState,
  entry: ApprovalQueueEntry
): Promise<NotificationBroadcastResult> {
  return notifyApprovalRequired(state, {
    pipelineId: entry.pipeline.id,
    pipelineName: entry.pipeline.name,
    stageId: entry.stage.id,
    stageName: entry.stage.name,
    requestedBy: entry.request.requestedBy,
    expiresInMs: entry.timeRemainingMs,
  });
}
