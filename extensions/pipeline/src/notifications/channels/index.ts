/**
 * Notification Channels Index
 *
 * This file exports all notification channel implementations for the pipeline
 * notification system. Each channel adapter implements the NotificationChannel
 * interface defined in hub.ts.
 *
 * Supported channels:
 * - Discord: Webhook-based notifications with rich embeds and action buttons
 * - Slack: Block Kit formatted messages with interactive components
 * - Telegram: Bot API integration with inline keyboards
 * - macOS: Native notification center via osascript
 *
 * @example
 * ```typescript
 * import {
 *   createDiscordChannel,
 *   createSlackChannel,
 *   createTelegramChannel,
 *   createMacOSChannel,
 * } from "./channels/index.js";
 *
 * // Create and register channels
 * const discordChannel = createDiscordChannel(config.discord);
 * const slackChannel = createSlackChannel(config.slack);
 *
 * hub.registerChannel("discord", discordChannel);
 * hub.registerChannel("slack", slackChannel);
 * ```
 */

// -----------------------------------------------------------------------------
// Discord Channel
// -----------------------------------------------------------------------------

export {
  DiscordChannel,
  createDiscordChannel,
  createAndInitializeDiscordChannel,
} from "./discord.js";

// -----------------------------------------------------------------------------
// Slack Channel
// -----------------------------------------------------------------------------

export {
  SlackChannel,
  createSlackChannel,
  createAndInitializeSlackChannel,
} from "./slack.js";

// -----------------------------------------------------------------------------
// Telegram Channel
// -----------------------------------------------------------------------------

export {
  TelegramChannel,
  createTelegramChannel,
  createAndInitializeTelegramChannel,
} from "./telegram.js";

// -----------------------------------------------------------------------------
// macOS Channel
// -----------------------------------------------------------------------------

export {
  MacOSChannel,
  createMacOSChannel,
  createAndInitializeMacOSChannel,
} from "./macos.js";

// -----------------------------------------------------------------------------
// Channel Factory
// -----------------------------------------------------------------------------

import type { NotificationChannel } from "../hub.js";
import type { NotificationChannelType } from "../../types.js";
import type { NotificationSettings } from "../../config.js";
import { DiscordChannel } from "./discord.js";
import { SlackChannel } from "./slack.js";
import { TelegramChannel } from "./telegram.js";
import { MacOSChannel } from "./macos.js";

/**
 * Channel factory error
 */
export class ChannelFactoryError extends Error {
  constructor(
    message: string,
    public readonly channelType: NotificationChannelType
  ) {
    super(message);
    this.name = "ChannelFactoryError";
  }
}

/**
 * Create notification channels from configuration
 *
 * Creates and returns an array of enabled notification channels based on
 * the provided configuration. Only returns channels that are enabled in
 * the configuration.
 *
 * @param config - Notification settings configuration
 * @returns Array of enabled notification channels
 *
 * @example
 * ```typescript
 * const channels = createChannelsFromConfig({
 *   discord: { enabled: true, webhookUrl: "..." },
 *   slack: { enabled: false },
 *   telegram: { enabled: true, botToken: "...", chatId: "..." },
 *   macos: { enabled: true },
 * });
 *
 * // Returns array with Discord, Telegram, and macOS channels
 * ```
 */
export function createChannelsFromConfig(
  config: NotificationSettings
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  // Discord
  if (config.discord?.enabled && config.discord.webhookUrl) {
    channels.push(new DiscordChannel(config.discord));
  }

  // Slack
  if (config.slack?.enabled && config.slack.webhookUrl) {
    channels.push(new SlackChannel(config.slack));
  }

  // Telegram
  if (config.telegram?.enabled && config.telegram.botToken && config.telegram.chatId) {
    channels.push(new TelegramChannel(config.telegram));
  }

  // macOS
  if (config.macos?.enabled) {
    channels.push(new MacOSChannel(config.macos));
  }

  return channels;
}

/**
 * Create a single notification channel by type
 *
 * Creates a notification channel instance for the specified type using
 * the provided configuration.
 *
 * @param type - Channel type to create
 * @param config - Notification settings containing channel configuration
 * @returns Notification channel instance
 * @throws ChannelFactoryError if channel type is invalid or not configured
 *
 * @example
 * ```typescript
 * const discordChannel = createChannelByType("discord", config);
 * await discordChannel.initialize();
 * ```
 */
export function createChannelByType(
  type: NotificationChannelType,
  config: NotificationSettings
): NotificationChannel {
  switch (type) {
    case "discord":
      if (!config.discord?.webhookUrl) {
        throw new ChannelFactoryError(
          "Discord webhook URL is required",
          "discord"
        );
      }
      return new DiscordChannel(config.discord);

    case "slack":
      if (!config.slack?.webhookUrl) {
        throw new ChannelFactoryError(
          "Slack webhook URL is required",
          "slack"
        );
      }
      return new SlackChannel(config.slack);

    case "telegram":
      if (!config.telegram?.botToken || !config.telegram?.chatId) {
        throw new ChannelFactoryError(
          "Telegram bot token and chat ID are required",
          "telegram"
        );
      }
      return new TelegramChannel(config.telegram);

    case "macos":
      return new MacOSChannel(config.macos ?? { enabled: true });

    default:
      throw new ChannelFactoryError(
        `Unknown channel type: ${type}`,
        type
      );
  }
}

/**
 * Get list of enabled channel types from configuration
 *
 * @param config - Notification settings configuration
 * @returns Array of enabled channel type identifiers
 *
 * @example
 * ```typescript
 * const enabledTypes = getEnabledChannelTypes(config);
 * // Returns: ["discord", "telegram", "macos"]
 * ```
 */
export function getEnabledChannelTypes(
  config: NotificationSettings
): NotificationChannelType[] {
  const types: NotificationChannelType[] = [];

  if (config.discord?.enabled && config.discord.webhookUrl) {
    types.push("discord");
  }

  if (config.slack?.enabled && config.slack.webhookUrl) {
    types.push("slack");
  }

  if (config.telegram?.enabled && config.telegram.botToken && config.telegram.chatId) {
    types.push("telegram");
  }

  if (config.macos?.enabled) {
    types.push("macos");
  }

  return types;
}

/**
 * Check if a channel type is properly configured
 *
 * @param type - Channel type to check
 * @param config - Notification settings configuration
 * @returns True if the channel has valid configuration
 */
export function isChannelConfigured(
  type: NotificationChannelType,
  config: NotificationSettings
): boolean {
  switch (type) {
    case "discord":
      return !!(config.discord?.enabled && config.discord.webhookUrl);

    case "slack":
      return !!(config.slack?.enabled && config.slack.webhookUrl);

    case "telegram":
      return !!(
        config.telegram?.enabled &&
        config.telegram.botToken &&
        config.telegram.chatId
      );

    case "macos":
      return !!config.macos?.enabled;

    default:
      return false;
  }
}
