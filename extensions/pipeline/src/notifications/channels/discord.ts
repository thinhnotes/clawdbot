/**
 * Discord Notification Channel
 *
 * Sends pipeline notifications to Discord via webhooks.
 * Supports rich embeds with action buttons for approval workflows.
 *
 * Features:
 * - Discord webhook integration
 * - Rich embed messages with color-coded status
 * - Action buttons for approval workflows (via components)
 * - Configurable username and avatar
 *
 * @example
 * ```typescript
 * import { DiscordChannel, createDiscordChannel } from "./discord.js";
 *
 * const channel = createDiscordChannel({
 *   webhookUrl: "https://discord.com/api/webhooks/...",
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
import type { DiscordNotificationConfig } from "../../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Discord embed field
 */
interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Discord embed
 */
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
  url?: string;
}

/**
 * Discord button component
 */
interface DiscordButton {
  type: 2; // Button
  style: 1 | 2 | 3 | 4 | 5; // Primary, Secondary, Success, Danger, Link
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

/**
 * Discord action row component
 */
interface DiscordActionRow {
  type: 1; // Action Row
  components: DiscordButton[];
}

/**
 * Discord webhook payload
 */
interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  thread_id?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Color codes for notification priorities */
const PRIORITY_COLORS: Record<NotificationPriority, number> = {
  low: 0x808080,    // Gray
  normal: 0x3498db, // Blue
  high: 0xe74c3c,   // Red
};

/** Color codes for notification types */
const TYPE_COLORS: Record<string, number> = {
  pipeline_started: 0x3498db,     // Blue
  pipeline_completed: 0x2ecc71,   // Green
  pipeline_failed: 0xe74c3c,      // Red
  stage_started: 0x3498db,        // Blue
  stage_completed: 0x2ecc71,      // Green
  stage_failed: 0xe74c3c,         // Red
  approval_required: 0xf39c12,    // Orange
  approval_completed: 0x9b59b6,   // Purple
};

/** Button style mapping */
const BUTTON_STYLES: Record<string, 1 | 2 | 3 | 4 | 5> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
};

// -----------------------------------------------------------------------------
// DiscordChannel Implementation
// -----------------------------------------------------------------------------

/**
 * Discord notification channel implementation.
 *
 * Sends notifications to Discord via webhooks with rich embeds
 * and interactive components for approval workflows.
 */
export class DiscordChannel implements NotificationChannel {
  readonly type: NotificationChannelType = "discord";
  readonly name = "Discord";

  private readonly config: DiscordNotificationConfig;
  private initialized = false;

  constructor(config: DiscordNotificationConfig) {
    this.config = config;
  }

  /**
   * Check if the channel is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.webhookUrl;
  }

  /**
   * Initialize the Discord channel
   * Validates webhook URL format
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.config.webhookUrl) {
      throw new Error("Discord webhook URL is required");
    }

    // Validate webhook URL format
    try {
      const url = new URL(this.config.webhookUrl);
      if (!url.hostname.includes("discord.com") && !url.hostname.includes("discordapp.com")) {
        throw new Error("Invalid Discord webhook URL");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid Discord webhook URL") {
        throw error;
      }
      throw new Error("Invalid Discord webhook URL format");
    }

    this.initialized = true;
  }

  /**
   * Send a notification to Discord
   */
  async send(notification: Notification): Promise<NotificationSendResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        channel: "discord",
        error: "Discord channel is not enabled",
        retryable: false,
      };
    }

    try {
      const payload = this.buildPayload(notification);
      const response = await this.sendWebhook(payload);

      if (response.ok) {
        return {
          success: true,
          channel: "discord",
          sentAt: Date.now(),
        };
      }

      // Handle rate limiting
      if (response.status === 429) {
        return {
          success: false,
          channel: "discord",
          error: "Rate limited by Discord",
          retryable: true,
        };
      }

      // Handle server errors
      if (response.status >= 500) {
        return {
          success: false,
          channel: "discord",
          error: `Discord server error: ${response.status}`,
          retryable: true,
        };
      }

      const errorBody = await response.text();
      return {
        success: false,
        channel: "discord",
        error: `Discord API error: ${response.status} - ${errorBody}`,
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        channel: "discord",
        error: `Failed to send Discord notification: ${message}`,
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
   * Build the Discord webhook payload
   */
  private buildPayload(notification: Notification): DiscordWebhookPayload {
    const embed = this.buildEmbed(notification);
    const components = this.buildComponents(notification);

    const payload: DiscordWebhookPayload = {
      embeds: [embed],
    };

    if (this.config.username) {
      payload.username = this.config.username;
    }

    if (this.config.avatarUrl) {
      payload.avatar_url = this.config.avatarUrl;
    }

    if (this.config.threadId) {
      payload.thread_id = this.config.threadId;
    }

    if (components.length > 0) {
      payload.components = components;
    }

    return payload;
  }

  /**
   * Build the Discord embed
   */
  private buildEmbed(notification: Notification): DiscordEmbed {
    const color = TYPE_COLORS[notification.type] ?? PRIORITY_COLORS[notification.priority];

    const embed: DiscordEmbed = {
      title: notification.title,
      description: notification.markdownMessage ?? notification.message,
      color,
      timestamp: new Date(notification.createdAt).toISOString(),
    };

    // Add fields for metadata
    const fields: DiscordEmbedField[] = [];

    if (notification.runId) {
      fields.push({
        name: "Run ID",
        value: `\`${notification.runId.slice(0, 8)}\``,
        inline: true,
      });
    }

    if (notification.stageId) {
      fields.push({
        name: "Stage",
        value: notification.stageId,
        inline: true,
      });
    }

    if (notification.metadata?.provider) {
      fields.push({
        name: "Provider",
        value: String(notification.metadata.provider),
        inline: true,
      });
    }

    if (notification.metadata?.durationMs) {
      fields.push({
        name: "Duration",
        value: this.formatDuration(Number(notification.metadata.durationMs)),
        inline: true,
      });
    }

    if (fields.length > 0) {
      embed.fields = fields;
    }

    // Add web URL
    if (notification.webUrl) {
      embed.url = notification.webUrl;
    }

    // Add footer
    embed.footer = {
      text: "Pipeline Notifications",
    };

    return embed;
  }

  /**
   * Build action row components for buttons
   */
  private buildComponents(notification: Notification): DiscordActionRow[] {
    const actions = notification.actions;
    if (!actions || actions.length === 0) {
      return [];
    }

    const buttons: DiscordButton[] = [];

    for (const action of actions) {
      // For URL buttons (like "View Details")
      if (action.url) {
        buttons.push({
          type: 2,
          style: 5, // Link style
          label: action.label,
          url: action.url,
        });
      } else {
        // For interactive buttons (approve/reject)
        // Note: These require a bot with interactions endpoint configured
        // For webhook-only integrations, we add the action as a link to a callback URL
        const style = BUTTON_STYLES[action.style ?? "primary"] ?? 1;
        buttons.push({
          type: 2,
          style: style === 5 ? 1 : style, // Link style requires URL
          label: action.label,
          custom_id: action.id,
        });
      }
    }

    // Add "View Details" button if web URL is available
    if (notification.webUrl && !actions.some((a) => a.url)) {
      buttons.push({
        type: 2,
        style: 5,
        label: "View Details",
        url: notification.webUrl,
      });
    }

    if (buttons.length === 0) {
      return [];
    }

    // Discord allows max 5 buttons per action row
    const actionRows: DiscordActionRow[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
      actionRows.push({
        type: 1,
        components: buttons.slice(i, i + 5),
      });
    }

    return actionRows;
  }

  /**
   * Send the webhook request
   */
  private async sendWebhook(payload: DiscordWebhookPayload): Promise<Response> {
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
 * Create a new Discord channel instance
 *
 * @param config - Discord channel configuration
 * @returns Uninitialized Discord channel instance
 */
export function createDiscordChannel(config: DiscordNotificationConfig): DiscordChannel {
  return new DiscordChannel(config);
}

/**
 * Create and initialize a Discord channel
 *
 * @param config - Discord channel configuration
 * @returns Initialized Discord channel instance
 */
export async function createAndInitializeDiscordChannel(
  config: DiscordNotificationConfig
): Promise<DiscordChannel> {
  const channel = createDiscordChannel(config);
  await channel.initialize();
  return channel;
}
