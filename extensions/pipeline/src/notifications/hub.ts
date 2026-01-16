/**
 * Notification Hub
 *
 * Hub pattern for dispatching notifications to multiple channels (Discord, Slack,
 * Telegram, macOS). Provides a central point for sending pipeline and approval
 * notifications with configurable routing and channel management.
 *
 * Features:
 * - Channel registration for multiple notification providers
 * - Notification dispatching to all enabled channels
 * - Configurable notification type filtering
 * - Event-based notification routing
 * - Retry logic for transient failures
 * - Integration with ApprovalQueue via ApprovalNotificationHub interface
 *
 * @example
 * ```typescript
 * import { NotificationHub, createNotificationHub } from "./hub.js";
 *
 * // Create hub with configuration
 * const hub = createNotificationHub({
 *   enabledTypes: ["pipeline_completed", "approval_required"],
 *   suppressedTypes: ["stage_started"],
 *   onlyOnFailure: false,
 *   includeStageNotifications: true,
 * });
 *
 * // Initialize hub
 * await hub.initialize();
 *
 * // Register notification channels
 * hub.registerChannel("discord", discordChannel);
 * hub.registerChannel("slack", slackChannel);
 *
 * // Send a notification
 * await hub.notify({
 *   id: "notif-1",
 *   type: "approval_required",
 *   priority: "high",
 *   title: "Approval Required",
 *   message: "Deploy to Production needs your approval",
 *   runId: "run-123",
 *   stageId: "deploy",
 *   approvalId: "approval-123",
 *   createdAt: Date.now(),
 * });
 * ```
 */

import { randomUUID } from "node:crypto";

import type {
  Notification,
  NotificationChannelType,
  NotificationPriority,
  NotificationType,
  ApprovalRequest,
  ApprovalResponse,
  PipelineRun,
  Stage,
} from "../types.js";
import type { ApprovalNotificationHub } from "../engine/approval.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Interface for notification channel implementations.
 * Each channel (Discord, Slack, Telegram, macOS) must implement this interface.
 */
export interface NotificationChannel {
  /** Channel type identifier */
  readonly type: NotificationChannelType;

  /** Human-readable channel name */
  readonly name: string;

  /** Whether the channel is currently enabled */
  isEnabled(): boolean;

  /**
   * Send a notification through this channel
   *
   * @param notification - The notification to send
   * @returns Promise resolving to send result
   */
  send(notification: Notification): Promise<NotificationSendResult>;

  /**
   * Initialize the channel (e.g., verify credentials)
   */
  initialize?(): Promise<void>;

  /**
   * Dispose the channel and clean up resources
   */
  dispose?(): Promise<void>;
}

/**
 * Result of sending a notification
 */
export interface NotificationSendResult {
  /** Whether the notification was sent successfully */
  success: boolean;
  /** Channel that sent the notification */
  channel: NotificationChannelType;
  /** Error message if sending failed */
  error?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Provider-specific message ID if available */
  messageId?: string;
  /** Timestamp of when the notification was sent */
  sentAt?: number;
}

/**
 * Configuration for the notification hub
 */
export interface NotificationHubConfig {
  /** Notification types to send (undefined = all types) */
  enabledTypes?: NotificationType[];
  /** Notification types to suppress (takes precedence over enabledTypes) */
  suppressedTypes?: NotificationType[];
  /** Only send notifications for failures */
  onlyOnFailure?: boolean;
  /** Include stage-level notifications (more verbose) */
  includeStageNotifications?: boolean;
  /** Maximum retry attempts for transient failures */
  maxRetryAttempts?: number;
  /** Retry delay in milliseconds (exponential backoff base) */
  retryDelayMs?: number;
}

/**
 * Input for creating a notification
 */
export interface CreateNotificationInput {
  /** Notification type */
  type: NotificationType;
  /** Notification priority */
  priority?: NotificationPriority;
  /** Short notification title */
  title: string;
  /** Notification message body */
  message: string;
  /** Markdown formatted message (optional) */
  markdownMessage?: string;
  /** Pipeline run ID (optional) */
  runId?: string;
  /** Stage ID (optional) */
  stageId?: string;
  /** Approval ID for approval notifications */
  approvalId?: string;
  /** Action buttons for the notification */
  actions?: Array<{
    id: string;
    label: string;
    style?: "primary" | "secondary" | "success" | "danger";
    url?: string;
  }>;
  /** URL to view details */
  webUrl?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Notification hub event types
 */
export type NotificationHubEventMap = {
  /** Emitted when a notification is sent to all channels */
  "notification.sent": {
    notification: Notification;
    results: NotificationSendResult[];
  };
  /** Emitted when a notification fails on a channel */
  "notification.failed": {
    notification: Notification;
    channel: NotificationChannelType;
    error: string;
    retryable: boolean;
  };
  /** Emitted when a channel is registered */
  "channel.registered": { channel: NotificationChannel };
  /** Emitted when a channel is unregistered */
  "channel.unregistered": { channelType: NotificationChannelType };
};

export type NotificationHubEventHandler<K extends keyof NotificationHubEventMap> = (
  event: NotificationHubEventMap[K]
) => void | Promise<void>;

/**
 * Statistics about the notification hub
 */
export interface NotificationHubStats {
  /** Total notifications sent */
  totalNotificationsSent: number;
  /** Notifications by type */
  byType: Record<NotificationType, number>;
  /** Total channel send attempts */
  totalChannelAttempts: number;
  /** Successful channel sends */
  successfulSends: number;
  /** Failed channel sends */
  failedSends: number;
  /** Number of registered channels */
  registeredChannels: number;
  /** Enabled channel types */
  enabledChannels: NotificationChannelType[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_MAX_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** Notification types that indicate failure */
const FAILURE_NOTIFICATION_TYPES = new Set<NotificationType>([
  "pipeline_failed",
  "stage_failed",
]);

/** Stage-level notification types */
const STAGE_NOTIFICATION_TYPES = new Set<NotificationType>([
  "stage_started",
  "stage_completed",
  "stage_failed",
]);

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by NotificationHub operations
 */
export class NotificationHubError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_INITIALIZED"
      | "CHANNEL_NOT_FOUND"
      | "CHANNEL_EXISTS"
      | "SEND_FAILED"
      | "VALIDATION_FAILED"
  ) {
    super(message);
    this.name = "NotificationHubError";
  }
}

// -----------------------------------------------------------------------------
// NotificationHub Implementation
// -----------------------------------------------------------------------------

/**
 * Hub for dispatching notifications to multiple channels.
 *
 * Provides:
 * - Channel registration and management
 * - Notification routing based on configuration
 * - Retry logic for transient failures
 * - Event emission for monitoring
 * - Integration with ApprovalQueue for approval notifications
 */
export class NotificationHub implements ApprovalNotificationHub {
  private readonly channels: Map<NotificationChannelType, NotificationChannel> = new Map();
  private readonly eventHandlers: Map<
    keyof NotificationHubEventMap,
    Set<NotificationHubEventHandler<keyof NotificationHubEventMap>>
  > = new Map();
  private readonly config: Required<NotificationHubConfig>;
  private initialized = false;

  // Statistics
  private stats = {
    totalNotificationsSent: 0,
    byType: {} as Record<NotificationType, number>,
    totalChannelAttempts: 0,
    successfulSends: 0,
    failedSends: 0,
  };

  constructor(config?: NotificationHubConfig) {
    this.config = {
      enabledTypes: config?.enabledTypes ?? [],
      suppressedTypes: config?.suppressedTypes ?? [],
      onlyOnFailure: config?.onlyOnFailure ?? false,
      includeStageNotifications: config?.includeStageNotifications ?? true,
      maxRetryAttempts: config?.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
      retryDelayMs: config?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the notification hub
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize all registered channels
    for (const channel of this.channels.values()) {
      if (channel.initialize) {
        await channel.initialize();
      }
    }

    this.initialized = true;
  }

  /**
   * Check if the hub is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose the notification hub and all channels
   */
  async dispose(): Promise<void> {
    // Dispose all channels
    for (const channel of this.channels.values()) {
      if (channel.dispose) {
        try {
          await channel.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    }

    this.channels.clear();
    this.eventHandlers.clear();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Channel Management
  // ---------------------------------------------------------------------------

  /**
   * Register a notification channel
   *
   * @param type - Channel type
   * @param channel - Channel implementation
   */
  registerChannel(type: NotificationChannelType, channel: NotificationChannel): void {
    if (this.channels.has(type)) {
      throw new NotificationHubError(
        `Channel already registered: ${type}`,
        "CHANNEL_EXISTS"
      );
    }

    this.channels.set(type, channel);
    this.emit("channel.registered", { channel });
  }

  /**
   * Unregister a notification channel
   *
   * @param type - Channel type to remove
   * @returns True if channel was removed
   */
  unregisterChannel(type: NotificationChannelType): boolean {
    const channel = this.channels.get(type);
    if (!channel) {
      return false;
    }

    this.channels.delete(type);
    this.emit("channel.unregistered", { channelType: type });

    // Dispose channel if it supports it
    if (channel.dispose) {
      channel.dispose().catch(() => {
        // Ignore disposal errors
      });
    }

    return true;
  }

  /**
   * Get a registered channel
   *
   * @param type - Channel type
   * @returns Channel or undefined
   */
  getChannel(type: NotificationChannelType): NotificationChannel | undefined {
    return this.channels.get(type);
  }

  /**
   * Get all registered channels
   */
  getChannels(): NotificationChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get enabled channels (registered and enabled)
   */
  getEnabledChannels(): NotificationChannel[] {
    return Array.from(this.channels.values()).filter((c) => c.isEnabled());
  }

  /**
   * Check if any channels are registered and enabled
   */
  hasEnabledChannels(): boolean {
    return this.getEnabledChannels().length > 0;
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to notification hub events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof NotificationHubEventMap>(
    event: K,
    handler: NotificationHubEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as NotificationHubEventHandler<keyof NotificationHubEventMap>);

    return () => {
      handlers?.delete(handler as NotificationHubEventHandler<keyof NotificationHubEventMap>);
    };
  }

  /**
   * Remove event handlers
   */
  off<K extends keyof NotificationHubEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private emit<K extends keyof NotificationHubEventMap>(
    event: K,
    payload: NotificationHubEventMap[K]
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        const result = (handler as NotificationHubEventHandler<K>)(payload);
        // Fire-and-forget for async handlers
        if (result instanceof Promise) {
          result.catch(() => {
            // Ignore async handler errors
          });
        }
      } catch {
        // Ignore synchronous handler errors
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Notification Sending
  // ---------------------------------------------------------------------------

  /**
   * Create and send a notification to all enabled channels
   *
   * @param input - Notification input
   * @returns Array of send results from each channel
   */
  async notify(input: CreateNotificationInput): Promise<NotificationSendResult[]> {
    const notification = this.createNotification(input);
    return this.sendNotification(notification);
  }

  /**
   * Send a notification to all enabled channels
   *
   * @param notification - The notification to send
   * @returns Array of send results from each channel
   */
  async sendNotification(notification: Notification): Promise<NotificationSendResult[]> {
    // Check if this notification type should be sent
    if (!this.shouldSendNotification(notification)) {
      return [];
    }

    const enabledChannels = this.getEnabledChannels();
    if (enabledChannels.length === 0) {
      return [];
    }

    // Update stats
    this.stats.totalNotificationsSent++;
    this.stats.byType[notification.type] = (this.stats.byType[notification.type] ?? 0) + 1;

    // Send to all enabled channels concurrently
    const results = await Promise.all(
      enabledChannels.map((channel) => this.sendToChannel(channel, notification))
    );

    // Emit event
    this.emit("notification.sent", { notification, results });

    return results;
  }

  /**
   * Create a notification object from input
   *
   * @param input - Notification creation input
   * @returns Created notification
   */
  createNotification(input: CreateNotificationInput): Notification {
    return {
      id: randomUUID(),
      type: input.type,
      priority: input.priority ?? "normal",
      title: input.title,
      message: input.message,
      markdownMessage: input.markdownMessage,
      runId: input.runId,
      stageId: input.stageId,
      approvalId: input.approvalId,
      actions: input.actions,
      webUrl: input.webUrl,
      metadata: input.metadata,
      createdAt: Date.now(),
    };
  }

  /**
   * Check if a notification should be sent based on configuration
   */
  private shouldSendNotification(notification: Notification): boolean {
    const { type } = notification;

    // Check if type is suppressed
    if (this.config.suppressedTypes.includes(type)) {
      return false;
    }

    // Check if only failures should be sent
    if (this.config.onlyOnFailure && !FAILURE_NOTIFICATION_TYPES.has(type)) {
      return false;
    }

    // Check if stage notifications should be included
    if (!this.config.includeStageNotifications && STAGE_NOTIFICATION_TYPES.has(type)) {
      return false;
    }

    // Check if type is in enabled types (empty = all types)
    if (this.config.enabledTypes.length > 0 && !this.config.enabledTypes.includes(type)) {
      return false;
    }

    return true;
  }

  /**
   * Send a notification to a specific channel with retry logic
   */
  private async sendToChannel(
    channel: NotificationChannel,
    notification: Notification
  ): Promise<NotificationSendResult> {
    let lastError: string | undefined;
    let attempts = 0;
    const maxAttempts = this.config.maxRetryAttempts + 1; // +1 for initial attempt

    while (attempts < maxAttempts) {
      attempts++;
      this.stats.totalChannelAttempts++;

      try {
        const result = await channel.send(notification);

        if (result.success) {
          this.stats.successfulSends++;
          return result;
        }

        // Check if we should retry
        if (!result.retryable || attempts >= maxAttempts) {
          this.stats.failedSends++;
          this.emit("notification.failed", {
            notification,
            channel: channel.type,
            error: result.error ?? "Unknown error",
            retryable: result.retryable ?? false,
          });
          return result;
        }

        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        if (attempts >= maxAttempts) {
          this.stats.failedSends++;
          this.emit("notification.failed", {
            notification,
            channel: channel.type,
            error: lastError,
            retryable: false,
          });
          return {
            success: false,
            channel: channel.type,
            error: lastError,
            retryable: false,
          };
        }
      }

      // Exponential backoff before retry
      if (attempts < maxAttempts) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempts - 1);
        await this.sleep(delay);
      }
    }

    // Should not reach here, but handle just in case
    this.stats.failedSends++;
    return {
      success: false,
      channel: channel.type,
      error: lastError ?? "Max retry attempts exceeded",
      retryable: false,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // ApprovalNotificationHub Interface Implementation
  // ---------------------------------------------------------------------------

  /**
   * Send notification for new approval request
   * Implements ApprovalNotificationHub interface
   */
  async notifyApprovalRequired(approval: ApprovalRequest): Promise<void> {
    await this.notify({
      type: "approval_required",
      priority: "high",
      title: "Approval Required",
      message: `Stage "${approval.stageName}" in pipeline "${approval.pipelineName}" requires approval.`,
      markdownMessage: `**Stage "${approval.stageName}"** in pipeline **${approval.pipelineName}** requires approval.${
        approval.instructions ? `\n\n${approval.instructions}` : ""
      }`,
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
    });
  }

  /**
   * Send notification for approval completion
   * Implements ApprovalNotificationHub interface
   */
  async notifyApprovalCompleted(
    approval: ApprovalRequest,
    response: ApprovalResponse
  ): Promise<void> {
    const isApproved = response.decision === "approve";
    const decision = isApproved ? "approved" : "rejected";

    await this.notify({
      type: "approval_completed",
      priority: "normal",
      title: `Stage ${isApproved ? "Approved" : "Rejected"}`,
      message: `Stage "${approval.stageName}" was ${decision}${
        response.approvedBy ? ` by ${response.approvedBy}` : ""
      }.${response.comment ? ` Comment: ${response.comment}` : ""}`,
      markdownMessage: `Stage **"${approval.stageName}"** was ${decision}${
        response.approvedBy ? ` by **${response.approvedBy}**` : ""
      }.${response.comment ? `\n\n> ${response.comment}` : ""}`,
      runId: approval.runId,
      stageId: approval.stageId,
      approvalId: approval.id,
      metadata: {
        decision: response.decision,
        approvedBy: response.approvedBy,
        approvedAt: response.approvedAt,
      },
    });
  }

  /**
   * Send notification for approval timeout
   * Implements ApprovalNotificationHub interface
   */
  async notifyApprovalTimeout(approval: ApprovalRequest): Promise<void> {
    await this.notify({
      type: "stage_failed",
      priority: "high",
      title: "Approval Timeout",
      message: `Stage "${approval.stageName}" approval request has timed out.`,
      markdownMessage: `Stage **"${approval.stageName}"** approval request has **timed out**.`,
      runId: approval.runId,
      stageId: approval.stageId,
      approvalId: approval.id,
      metadata: {
        reason: "timeout",
        expiresAt: approval.expiresAt,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Pipeline Event Notification Helpers
  // ---------------------------------------------------------------------------

  /**
   * Send notification for pipeline started
   */
  async notifyPipelineStarted(run: PipelineRun): Promise<NotificationSendResult[]> {
    return this.notify({
      type: "pipeline_started",
      priority: "low",
      title: "Pipeline Started",
      message: `Pipeline "${run.pipelineName}" has started.`,
      markdownMessage: `Pipeline **"${run.pipelineName}"** has started.${
        run.sourceBranch ? `\n\nBranch: \`${run.sourceBranch}\`` : ""
      }`,
      runId: run.id,
      webUrl: run.webUrl,
      metadata: {
        pipelineId: run.pipelineId,
        provider: run.provider,
        sourceBranch: run.sourceBranch,
        triggeredBy: run.triggeredBy,
      },
    });
  }

  /**
   * Send notification for pipeline completed
   */
  async notifyPipelineCompleted(run: PipelineRun): Promise<NotificationSendResult[]> {
    const isSuccess = run.result === "succeeded";
    const isFailed = run.result === "failed";

    return this.notify({
      type: isFailed ? "pipeline_failed" : "pipeline_completed",
      priority: isFailed ? "high" : "normal",
      title: `Pipeline ${isSuccess ? "Succeeded" : isFailed ? "Failed" : "Completed"}`,
      message: `Pipeline "${run.pipelineName}" ${run.result ?? "completed"}.${
        run.durationMs ? ` Duration: ${this.formatDuration(run.durationMs)}` : ""
      }`,
      markdownMessage: `Pipeline **"${run.pipelineName}"** ${run.result ?? "completed"}.${
        run.durationMs ? `\n\nDuration: ${this.formatDuration(run.durationMs)}` : ""
      }`,
      runId: run.id,
      webUrl: run.webUrl,
      metadata: {
        pipelineId: run.pipelineId,
        provider: run.provider,
        result: run.result,
        durationMs: run.durationMs,
      },
    });
  }

  /**
   * Send notification for stage started
   */
  async notifyStageStarted(run: PipelineRun, stage: Stage): Promise<NotificationSendResult[]> {
    return this.notify({
      type: "stage_started",
      priority: "low",
      title: "Stage Started",
      message: `Stage "${stage.name}" in pipeline "${run.pipelineName}" has started.`,
      markdownMessage: `Stage **"${stage.name}"** in pipeline **"${run.pipelineName}"** has started.`,
      runId: run.id,
      stageId: stage.id,
      webUrl: run.webUrl,
      metadata: {
        pipelineId: run.pipelineId,
        provider: run.provider,
        stageOrder: stage.order,
      },
    });
  }

  /**
   * Send notification for stage completed
   */
  async notifyStageCompleted(run: PipelineRun, stage: Stage): Promise<NotificationSendResult[]> {
    const isSuccess = stage.result === "succeeded";
    const isFailed = stage.result === "failed";

    return this.notify({
      type: isFailed ? "stage_failed" : "stage_completed",
      priority: isFailed ? "high" : "normal",
      title: `Stage ${isSuccess ? "Succeeded" : isFailed ? "Failed" : "Completed"}`,
      message: `Stage "${stage.name}" in pipeline "${run.pipelineName}" ${stage.result ?? "completed"}.${
        stage.durationMs ? ` Duration: ${this.formatDuration(stage.durationMs)}` : ""
      }`,
      markdownMessage: `Stage **"${stage.name}"** in pipeline **"${run.pipelineName}"** ${stage.result ?? "completed"}.${
        stage.durationMs ? `\n\nDuration: ${this.formatDuration(stage.durationMs)}` : ""
      }`,
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
    });
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  /**
   * Get notification hub statistics
   */
  getStats(): NotificationHubStats {
    return {
      totalNotificationsSent: this.stats.totalNotificationsSent,
      byType: { ...this.stats.byType } as Record<NotificationType, number>,
      totalChannelAttempts: this.stats.totalChannelAttempts,
      successfulSends: this.stats.successfulSends,
      failedSends: this.stats.failedSends,
      registeredChannels: this.channels.size,
      enabledChannels: this.getEnabledChannels().map((c) => c.type),
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalNotificationsSent: 0,
      byType: {} as Record<NotificationType, number>,
      totalChannelAttempts: 0,
      successfulSends: 0,
      failedSends: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
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
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new notification hub instance
 *
 * @param config - Optional configuration
 * @returns Uninitialized hub instance (call initialize() before use)
 */
export function createNotificationHub(config?: NotificationHubConfig): NotificationHub {
  return new NotificationHub(config);
}

/**
 * Create and initialize a notification hub
 *
 * @param config - Optional configuration
 * @returns Initialized hub instance
 */
export async function createAndInitializeNotificationHub(
  config?: NotificationHubConfig
): Promise<NotificationHub> {
  const hub = createNotificationHub(config);
  await hub.initialize();
  return hub;
}

// -----------------------------------------------------------------------------
// Re-exports for convenience
// -----------------------------------------------------------------------------

export type { Notification, NotificationChannelType, NotificationType, NotificationPriority };
