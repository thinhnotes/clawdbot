/**
 * Telegram Notification Channel
 *
 * Sends pipeline notifications to Telegram via Bot API.
 * Supports inline keyboards for approval workflows and various parse modes.
 *
 * Features:
 * - Telegram Bot API integration
 * - Multiple parse modes (HTML, Markdown, MarkdownV2)
 * - Inline keyboards for interactive buttons
 * - Configurable notification settings
 *
 * @example
 * ```typescript
 * import { TelegramChannel, createTelegramChannel } from "./telegram.js";
 *
 * const channel = createTelegramChannel({
 *   botToken: "123456:ABC-DEF...",
 *   chatId: "-100123456789",
 *   parseMode: "HTML",
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
import type { TelegramNotificationConfig } from "../../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Telegram inline keyboard button
 */
interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/**
 * Telegram inline keyboard markup
 */
interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/**
 * Telegram sendMessage request payload
 */
interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_markup?: TelegramInlineKeyboardMarkup;
}

/**
 * Telegram API response
 */
interface TelegramApiResponse {
  ok: boolean;
  result?: {
    message_id: number;
  };
  description?: string;
  error_code?: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Telegram Bot API base URL */
const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Emoji for notification priorities */
const PRIORITY_EMOJI: Record<NotificationPriority, string> = {
  low: "",
  normal: "",
  high: "🚨 ",
};

/** Emoji for notification types */
const TYPE_EMOJI: Record<string, string> = {
  pipeline_started: "🚀",
  pipeline_completed: "✅",
  pipeline_failed: "❌",
  stage_started: "▶️",
  stage_completed: "✔️",
  stage_failed: "⚠️",
  approval_required: "✋",
  approval_completed: "☑️",
};

// -----------------------------------------------------------------------------
// TelegramChannel Implementation
// -----------------------------------------------------------------------------

/**
 * Telegram notification channel implementation.
 *
 * Sends notifications to Telegram via Bot API with formatted messages
 * and inline keyboards for approval workflows.
 */
export class TelegramChannel implements NotificationChannel {
  readonly type: NotificationChannelType = "telegram";
  readonly name = "Telegram";

  private readonly config: TelegramNotificationConfig;
  private initialized = false;

  constructor(config: TelegramNotificationConfig) {
    this.config = {
      parseMode: "HTML",
      disableWebPagePreview: false,
      disableNotification: false,
      ...config,
    };
  }

  /**
   * Check if the channel is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.botToken && !!this.config.chatId;
  }

  /**
   * Initialize the Telegram channel
   * Validates bot token and chat ID
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.config.botToken) {
      throw new Error("Telegram bot token is required");
    }

    if (!this.config.chatId) {
      throw new Error("Telegram chat ID is required");
    }

    // Validate bot token format (should be number:alphanumeric)
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(this.config.botToken)) {
      throw new Error("Invalid Telegram bot token format");
    }

    this.initialized = true;
  }

  /**
   * Send a notification to Telegram
   */
  async send(notification: Notification): Promise<NotificationSendResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        channel: "telegram",
        error: "Telegram channel is not enabled",
        retryable: false,
      };
    }

    try {
      const payload = this.buildPayload(notification);
      const response = await this.sendMessage(payload);

      if (response.ok) {
        return {
          success: true,
          channel: "telegram",
          messageId: response.result?.message_id?.toString(),
          sentAt: Date.now(),
        };
      }

      // Handle rate limiting (error code 429)
      if (response.error_code === 429) {
        return {
          success: false,
          channel: "telegram",
          error: "Rate limited by Telegram",
          retryable: true,
        };
      }

      return {
        success: false,
        channel: "telegram",
        error: `Telegram API error: ${response.description ?? "Unknown error"}`,
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        channel: "telegram",
        error: `Failed to send Telegram notification: ${message}`,
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
   * Build the Telegram message payload
   */
  private buildPayload(notification: Notification): TelegramSendMessagePayload {
    const text = this.formatMessage(notification);
    const replyMarkup = this.buildInlineKeyboard(notification);

    const payload: TelegramSendMessagePayload = {
      chat_id: this.config.chatId!,
      text,
      parse_mode: this.config.parseMode,
      disable_web_page_preview: this.config.disableWebPagePreview,
      disable_notification: this.config.disableNotification,
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    return payload;
  }

  /**
   * Format the notification message
   */
  private formatMessage(notification: Notification): string {
    const emoji = TYPE_EMOJI[notification.type] ?? "📢";
    const priorityEmoji = PRIORITY_EMOJI[notification.priority];
    const parseMode = this.config.parseMode ?? "HTML";

    let message = "";

    // Title
    if (parseMode === "HTML") {
      message += `${priorityEmoji}${emoji} <b>${this.escapeHtml(notification.title)}</b>\n\n`;
    } else if (parseMode === "MarkdownV2") {
      message += `${priorityEmoji}${emoji} *${this.escapeMarkdownV2(notification.title)}*\n\n`;
    } else {
      message += `${priorityEmoji}${emoji} *${this.escapeMarkdown(notification.title)}*\n\n`;
    }

    // Message body
    const body = notification.markdownMessage ?? notification.message;
    if (parseMode === "HTML") {
      message += this.convertToHtml(body) + "\n\n";
    } else if (parseMode === "MarkdownV2") {
      message += this.convertToMarkdownV2(body) + "\n\n";
    } else {
      message += body + "\n\n";
    }

    // Metadata
    const metadata: string[] = [];

    if (notification.runId) {
      const runIdShort = notification.runId.slice(0, 8);
      if (parseMode === "HTML") {
        metadata.push(`Run: <code>${runIdShort}</code>`);
      } else if (parseMode === "MarkdownV2") {
        metadata.push(`Run: \`${runIdShort}\``);
      } else {
        metadata.push(`Run: \`${runIdShort}\``);
      }
    }

    if (notification.stageId) {
      metadata.push(`Stage: ${notification.stageId}`);
    }

    if (notification.metadata?.provider) {
      metadata.push(`Provider: ${notification.metadata.provider}`);
    }

    if (notification.metadata?.durationMs) {
      metadata.push(`Duration: ${this.formatDuration(Number(notification.metadata.durationMs))}`);
    }

    if (metadata.length > 0) {
      message += metadata.join(" | ") + "\n\n";
    }

    // Timestamp
    const timestamp = new Date(notification.createdAt).toLocaleString();
    if (parseMode === "HTML") {
      message += `<i>${timestamp}</i>`;
    } else if (parseMode === "MarkdownV2") {
      message += `_${this.escapeMarkdownV2(timestamp)}_`;
    } else {
      message += `_${timestamp}_`;
    }

    return message;
  }

  /**
   * Build inline keyboard markup
   */
  private buildInlineKeyboard(notification: Notification): TelegramInlineKeyboardMarkup | undefined {
    const buttons: TelegramInlineKeyboardButton[][] = [];
    const row: TelegramInlineKeyboardButton[] = [];

    // Add notification actions
    if (notification.actions) {
      for (const action of notification.actions) {
        const button: TelegramInlineKeyboardButton = {
          text: action.label,
        };

        if (action.url) {
          button.url = action.url;
        } else {
          // For non-URL buttons, use callback_data
          // Note: callback_data requires a webhook to handle
          button.callback_data = action.id;
        }

        row.push(button);

        // Max 8 buttons per row, but 2-3 is typical for readability
        if (row.length >= 3) {
          buttons.push([...row]);
          row.length = 0;
        }
      }
    }

    // Add "View Details" button if web URL is available
    if (notification.webUrl) {
      row.push({
        text: "📋 View Details",
        url: notification.webUrl,
      });
    }

    // Push remaining buttons
    if (row.length > 0) {
      buttons.push(row);
    }

    if (buttons.length === 0) {
      return undefined;
    }

    return {
      inline_keyboard: buttons,
    };
  }

  /**
   * Send message via Telegram Bot API
   */
  private async sendMessage(payload: TelegramSendMessagePayload): Promise<TelegramApiResponse> {
    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    return response.json() as Promise<TelegramApiResponse>;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Escape Markdown special characters
   */
  private escapeMarkdown(text: string): string {
    return text
      .replace(/[_*`\[]/g, "\\$&");
  }

  /**
   * Escape MarkdownV2 special characters
   */
  private escapeMarkdownV2(text: string): string {
    return text
      .replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
  }

  /**
   * Convert standard markdown to HTML
   */
  private convertToHtml(text: string): string {
    return text
      // Bold: **text** to <b>text</b>
      .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
      // Italic: *text* to <i>text</i>
      .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
      // Code: `code` to <code>code</code>
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Links: [text](url) to <a href="url">text</a>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Escape remaining special characters
      .replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;")
      .replace(/<(?![/]?(?:b|i|u|s|a|code|pre)[ >])/g, "&lt;");
  }

  /**
   * Convert standard markdown to MarkdownV2
   */
  private convertToMarkdownV2(text: string): string {
    // First escape special characters that are not part of formatting
    let result = text
      // Temporarily mark formatting
      .replace(/\*\*(.*?)\*\*/g, "BOLD_START$1BOLD_END")
      .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, "ITALIC_START$1ITALIC_END")
      .replace(/`([^`]+)`/g, "CODE_START$1CODE_END");

    // Escape special characters
    result = result.replace(/[_\[\]()~>#+=|{}.!-]/g, "\\$&");

    // Restore formatting
    result = result
      .replace(/BOLD_START/g, "*")
      .replace(/BOLD_END/g, "*")
      .replace(/ITALIC_START/g, "_")
      .replace(/ITALIC_END/g, "_")
      .replace(/CODE_START/g, "`")
      .replace(/CODE_END/g, "`");

    return result;
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
 * Create a new Telegram channel instance
 *
 * @param config - Telegram channel configuration
 * @returns Uninitialized Telegram channel instance
 */
export function createTelegramChannel(config: TelegramNotificationConfig): TelegramChannel {
  return new TelegramChannel(config);
}

/**
 * Create and initialize a Telegram channel
 *
 * @param config - Telegram channel configuration
 * @returns Initialized Telegram channel instance
 */
export async function createAndInitializeTelegramChannel(
  config: TelegramNotificationConfig
): Promise<TelegramChannel> {
  const channel = createTelegramChannel(config);
  await channel.initialize();
  return channel;
}
