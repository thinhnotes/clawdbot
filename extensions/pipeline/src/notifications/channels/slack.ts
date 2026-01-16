/**
 * Slack Notification Channel
 *
 * Sends pipeline notifications to Slack via webhooks.
 * Supports Block Kit for rich message formatting and interactive elements.
 *
 * Features:
 * - Slack incoming webhook integration
 * - Block Kit message formatting
 * - Interactive buttons for approval workflows
 * - Configurable username, channel, and icon
 *
 * @example
 * ```typescript
 * import { SlackChannel, createSlackChannel } from "./slack.js";
 *
 * const channel = createSlackChannel({
 *   webhookUrl: "https://hooks.slack.com/services/...",
 *   channel: "#pipelines",
 *   username: "Pipeline Bot",
 * });
 *
 * await channel.initialize();
 * await channel.send(notification);
 * ```
 */

import type { NotificationChannel, NotificationSendResult } from "../hub.js";
import type {
  Notification,
  NotificationChannelType,
  NotificationPriority,
} from "../../types.js";
import type { SlackNotificationConfig } from "../../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Slack text object
 */
interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

/**
 * Slack section block
 */
interface SlackSectionBlock {
  type: "section";
  text?: SlackTextObject;
  block_id?: string;
  fields?: SlackTextObject[];
  accessory?: SlackButtonElement;
}

/**
 * Slack divider block
 */
interface SlackDividerBlock {
  type: "divider";
}

/**
 * Slack context block
 */
interface SlackContextBlock {
  type: "context";
  elements: SlackTextObject[];
  block_id?: string;
}

/**
 * Slack header block
 */
interface SlackHeaderBlock {
  type: "header";
  text: SlackTextObject;
  block_id?: string;
}

/**
 * Slack actions block
 */
interface SlackActionsBlock {
  type: "actions";
  elements: SlackButtonElement[];
  block_id?: string;
}

/**
 * Slack button element
 */
interface SlackButtonElement {
  type: "button";
  text: SlackTextObject;
  action_id?: string;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
}

/**
 * Slack block types
 */
type SlackBlock =
  | SlackSectionBlock
  | SlackDividerBlock
  | SlackContextBlock
  | SlackHeaderBlock
  | SlackActionsBlock;

/**
 * Slack webhook payload
 */
interface SlackWebhookPayload {
  text?: string;
  channel?: string;
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

/**
 * Slack attachment (for color bar)
 */
interface SlackAttachment {
  color?: string;
  blocks?: SlackBlock[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Color codes for notification priorities */
const PRIORITY_COLORS: Record<NotificationPriority, string> = {
  low: "#808080",    // Gray
  normal: "#3498db", // Blue
  high: "#e74c3c",   // Red
};

/** Color codes for notification types */
const TYPE_COLORS: Record<string, string> = {
  pipeline_started: "#3498db",     // Blue
  pipeline_completed: "#2ecc71",   // Green
  pipeline_failed: "#e74c3c",      // Red
  stage_started: "#3498db",        // Blue
  stage_completed: "#2ecc71",      // Green
  stage_failed: "#e74c3c",         // Red
  approval_required: "#f39c12",    // Orange
  approval_completed: "#9b59b6",   // Purple
};

/** Emoji for notification types */
const TYPE_EMOJI: Record<string, string> = {
  pipeline_started: ":rocket:",
  pipeline_completed: ":white_check_mark:",
  pipeline_failed: ":x:",
  stage_started: ":arrow_forward:",
  stage_completed: ":heavy_check_mark:",
  stage_failed: ":warning:",
  approval_required: ":raised_hand:",
  approval_completed: ":ballot_box_with_check:",
};

// -----------------------------------------------------------------------------
// SlackChannel Implementation
// -----------------------------------------------------------------------------

/**
 * Slack notification channel implementation.
 *
 * Sends notifications to Slack via webhooks with Block Kit formatting
 * and interactive buttons for approval workflows.
 */
export class SlackChannel implements NotificationChannel {
  readonly type: NotificationChannelType = "slack";
  readonly name = "Slack";

  private readonly config: SlackNotificationConfig;
  private initialized = false;

  constructor(config: SlackNotificationConfig) {
    this.config = config;
  }

  /**
   * Check if the channel is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.webhookUrl;
  }

  /**
   * Initialize the Slack channel
   * Validates webhook URL format
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.config.webhookUrl) {
      throw new Error("Slack webhook URL is required");
    }

    // Validate webhook URL format
    try {
      const url = new URL(this.config.webhookUrl);
      if (!url.hostname.includes("slack.com") && !url.hostname.includes("hooks.slack.com")) {
        throw new Error("Invalid Slack webhook URL");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid Slack webhook URL") {
        throw error;
      }
      throw new Error("Invalid Slack webhook URL format");
    }

    this.initialized = true;
  }

  /**
   * Send a notification to Slack
   */
  async send(notification: Notification): Promise<NotificationSendResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        channel: "slack",
        error: "Slack channel is not enabled",
        retryable: false,
      };
    }

    try {
      const payload = this.buildPayload(notification);
      const response = await this.sendWebhook(payload);

      if (response.ok) {
        return {
          success: true,
          channel: "slack",
          sentAt: Date.now(),
        };
      }

      // Handle rate limiting
      if (response.status === 429) {
        return {
          success: false,
          channel: "slack",
          error: "Rate limited by Slack",
          retryable: true,
        };
      }

      // Handle server errors
      if (response.status >= 500) {
        return {
          success: false,
          channel: "slack",
          error: `Slack server error: ${response.status}`,
          retryable: true,
        };
      }

      const errorBody = await response.text();
      return {
        success: false,
        channel: "slack",
        error: `Slack API error: ${response.status} - ${errorBody}`,
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        channel: "slack",
        error: `Failed to send Slack notification: ${message}`,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Dispose the channel
   */
  async dispose(): Promise<void> {
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Build the Slack webhook payload
   */
  private buildPayload(notification: Notification): SlackWebhookPayload {
    const blocks = this.buildBlocks(notification);
    const color = TYPE_COLORS[notification.type] ?? PRIORITY_COLORS[notification.priority];

    const payload: SlackWebhookPayload = {
      // Fallback text for notifications
      text: `${notification.title}: ${notification.message}`,
      // Use attachments for the color bar
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };

    if (this.config.channel) {
      payload.channel = this.config.channel;
    }

    if (this.config.username) {
      payload.username = this.config.username;
    }

    if (this.config.iconUrl) {
      payload.icon_url = this.config.iconUrl;
    } else if (this.config.iconEmoji) {
      payload.icon_emoji = this.config.iconEmoji;
    }

    return payload;
  }

  /**
   * Build Slack Block Kit blocks
   */
  private buildBlocks(notification: Notification): SlackBlock[] {
    const blocks: SlackBlock[] = [];
    const emoji = TYPE_EMOJI[notification.type] ?? ":bell:";

    // Header block
    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} ${notification.title}`,
        emoji: true,
      },
    });

    // Main content section
    const messageText = notification.markdownMessage ?? notification.message;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: this.convertToSlackMarkdown(messageText),
      },
    });

    // Metadata fields
    const fields: SlackTextObject[] = [];

    if (notification.runId) {
      fields.push({
        type: "mrkdwn",
        text: `*Run ID:*\n\`${notification.runId.slice(0, 8)}\``,
      });
    }

    if (notification.stageId) {
      fields.push({
        type: "mrkdwn",
        text: `*Stage:*\n${notification.stageId}`,
      });
    }

    if (notification.metadata?.provider) {
      fields.push({
        type: "mrkdwn",
        text: `*Provider:*\n${notification.metadata.provider}`,
      });
    }

    if (notification.metadata?.durationMs) {
      fields.push({
        type: "mrkdwn",
        text: `*Duration:*\n${this.formatDuration(Number(notification.metadata.durationMs))}`,
      });
    }

    if (fields.length > 0) {
      blocks.push({
        type: "section",
        fields: fields.slice(0, 10), // Slack allows max 10 fields
      });
    }

    // Action buttons
    const actionElements = this.buildActionElements(notification);
    if (actionElements.length > 0) {
      blocks.push({
        type: "actions",
        elements: actionElements,
      });
    }

    // Context footer
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Pipeline Notifications | ${new Date(notification.createdAt).toLocaleString()}`,
        },
      ],
    });

    return blocks;
  }

  /**
   * Build action button elements
   */
  private buildActionElements(notification: Notification): SlackButtonElement[] {
    const elements: SlackButtonElement[] = [];

    // Add notification actions
    if (notification.actions) {
      for (const action of notification.actions) {
        const button: SlackButtonElement = {
          type: "button",
          text: {
            type: "plain_text",
            text: action.label,
            emoji: true,
          },
        };

        if (action.url) {
          button.url = action.url;
        } else {
          button.action_id = action.id;
          button.value = action.id;
        }

        // Map style to Slack button style
        if (action.style === "success" || action.style === "primary") {
          button.style = "primary";
        } else if (action.style === "danger") {
          button.style = "danger";
        }

        elements.push(button);
      }
    }

    // Add "View Details" button if web URL is available
    if (notification.webUrl) {
      elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: "View Details",
          emoji: true,
        },
        url: notification.webUrl,
      });
    }

    // Slack allows max 25 elements, but typically 5 is reasonable
    return elements.slice(0, 5);
  }

  /**
   * Convert standard markdown to Slack mrkdwn format
   */
  private convertToSlackMarkdown(text: string): string {
    return text
      // Convert bold: **text** or __text__ to *text*
      .replace(/\*\*(.*?)\*\*/g, "*$1*")
      .replace(/__(.*?)__/g, "*$1*")
      // Convert italic: *text* (single) to _text_ (avoid double asterisks already converted)
      .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "_$1_")
      // Convert links: [text](url) to <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Convert inline code: `code` stays the same
      // Convert blockquotes: > text stays the same
      // Convert strikethrough: ~~text~~ to ~text~
      .replace(/~~(.*?)~~/g, "~$1~");
  }

  /**
   * Send the webhook request
   */
  private async sendWebhook(payload: SlackWebhookPayload): Promise<Response> {
    const url = this.config.webhookUrl!;

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes("network") ||
        message.includes("timeout") ||
        message.includes("econnreset") ||
        message.includes("econnrefused")
      );
    }
    return false;
  }

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
 * Create a new Slack channel instance
 *
 * @param config - Slack channel configuration
 * @returns Uninitialized Slack channel instance
 */
export function createSlackChannel(config: SlackNotificationConfig): SlackChannel {
  return new SlackChannel(config);
}

/**
 * Create and initialize a Slack channel
 *
 * @param config - Slack channel configuration
 * @returns Initialized Slack channel instance
 */
export async function createAndInitializeSlackChannel(
  config: SlackNotificationConfig
): Promise<SlackChannel> {
  const channel = createSlackChannel(config);
  await channel.initialize();
  return channel;
}
