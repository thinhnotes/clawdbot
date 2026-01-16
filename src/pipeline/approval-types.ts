import type { ApprovalRequest, ApprovalStatus, Pipeline, Stage } from "./types.js";

/**
 * Approval Action
 * The action taken on an approval request.
 */
export type ApprovalAction = "approve" | "reject";

/**
 * Approval Result
 * The result of processing an approval action.
 */
export type ApprovalResult = {
  /** The action that was taken */
  action: ApprovalAction;
  /** User/system that processed the approval */
  approvedBy: string;
  /** Timestamp when the action was taken (ms since epoch) */
  timestampMs: number;
  /** Optional comment explaining the decision */
  comment?: string;
  /** Whether the action was successful */
  success: boolean;
  /** Error message if the action failed */
  error?: string;
};

/**
 * Approval Queue Entry
 * An entry in the approval queue with full context.
 */
export type ApprovalQueueEntry = {
  /** The approval request */
  request: ApprovalRequest;
  /** The pipeline this approval is for */
  pipeline: Pipeline;
  /** The stage awaiting approval */
  stage: Stage;
  /** Time remaining before timeout (if timeout configured) */
  timeRemainingMs?: number;
};

/**
 * Approval Queue
 * Collection of pending approval requests with metadata.
 */
export type ApprovalQueue = {
  /** List of pending approval entries */
  pending: ApprovalQueueEntry[];
  /** Total count of pending approvals */
  count: number;
  /** Timestamp when the queue was last updated (ms since epoch) */
  lastUpdatedMs: number;
};

/**
 * Approval Notification Type
 * Type of notification being sent.
 */
export type ApprovalNotificationType =
  | "approval_required"
  | "approval_processed"
  | "approval_timeout"
  | "approval_reminder";

/**
 * Approval Notification Channel
 * The channel through which to send the notification.
 */
export type ApprovalNotificationChannel =
  | "discord"
  | "slack"
  | "telegram"
  | "push";

/**
 * Approval Notification
 * A notification sent about an approval event.
 */
export type ApprovalNotification = {
  /** Unique notification ID */
  id: string;
  /** Type of notification */
  type: ApprovalNotificationType;
  /** Target channel for delivery */
  channel: ApprovalNotificationChannel;
  /** Recipient identifier (channel ID, user ID, etc.) */
  recipient: string;
  /** Pipeline ID this notification is about */
  pipelineId: string;
  /** Pipeline name for display */
  pipelineName: string;
  /** Stage ID this notification is about */
  stageId: string;
  /** Stage name for display */
  stageName: string;
  /** Notification title */
  title: string;
  /** Notification body/message */
  body: string;
  /** Action buttons/commands to include */
  actions?: ApprovalNotificationAction[];
  /** When the notification was created (ms since epoch) */
  createdAtMs: number;
  /** When the notification was sent (ms since epoch) */
  sentAtMs?: number;
  /** Whether the notification was delivered successfully */
  delivered?: boolean;
  /** Delivery error if any */
  deliveryError?: string;
};

/**
 * Approval Notification Action
 * An actionable button or command in a notification.
 */
export type ApprovalNotificationAction = {
  /** Action label for display */
  label: string;
  /** Action type */
  action: ApprovalAction | "view";
  /** Command to execute (e.g., "/approve pipeline-123 build") */
  command?: string;
  /** URL to navigate to */
  url?: string;
};

/**
 * Approval Event
 * An event emitted during the approval workflow.
 */
export type ApprovalEvent =
  | { kind: "approval_requested"; request: ApprovalRequest }
  | { kind: "approval_processed"; request: ApprovalRequest; result: ApprovalResult }
  | { kind: "approval_timeout"; request: ApprovalRequest }
  | { kind: "approval_reminder"; request: ApprovalRequest };

/**
 * Approval Handler
 * Function signature for handling approval events.
 */
export type ApprovalHandler = (event: ApprovalEvent) => void | Promise<void>;

/**
 * Approval Processor Input
 * Input for processing an approval action.
 */
export type ApprovalProcessorInput = {
  /** Pipeline ID */
  pipelineId: string;
  /** Stage ID */
  stageId: string;
  /** Action to take */
  action: ApprovalAction;
  /** User/system processing the action */
  processedBy: string;
  /** Optional comment */
  comment?: string;
};

/**
 * Approval Timeout Config
 * Configuration for approval timeout behavior.
 */
export type ApprovalTimeoutConfig = {
  /** Timeout duration in milliseconds */
  timeoutMs: number;
  /** Action to take on timeout */
  onTimeout: "expire" | "auto_approve" | "auto_reject";
  /** Whether to send reminder notifications */
  sendReminders: boolean;
  /** When to send reminders (ms before timeout) */
  reminderBeforeMs?: number[];
};

/**
 * Approval History Entry
 * A historical record of an approval action.
 */
export type ApprovalHistoryEntry = {
  /** Approval request ID */
  requestId: string;
  /** Pipeline ID */
  pipelineId: string;
  /** Stage ID */
  stageId: string;
  /** Final status */
  status: ApprovalStatus;
  /** Who requested the approval */
  requestedBy?: string;
  /** When it was requested */
  requestedAtMs: number;
  /** Who processed it */
  processedBy?: string;
  /** When it was processed */
  processedAtMs?: number;
  /** The action taken */
  action?: ApprovalAction;
  /** Comment on the decision */
  comment?: string;
};
