/**
 * macOS Notification Channel
 *
 * Sends pipeline notifications as native macOS notifications using osascript.
 * Provides local desktop notifications for pipeline events.
 *
 * Features:
 * - Native macOS notification center integration
 * - Configurable sounds
 * - Notification grouping
 * - Click-to-open URL support (when available)
 *
 * @example
 * ```typescript
 * import { MacOSChannel, createMacOSChannel } from "./macos.js";
 *
 * const channel = createMacOSChannel({
 *   enabled: true,
 *   sound: true,
 *   soundName: "Glass",
 *   group: "com.clawdbot.pipeline",
 * });
 *
 * await channel.initialize();
 * await channel.send(notification);
 * ```
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

import type { NotificationChannel, NotificationSendResult } from "../hub.js";
import type {
  Notification,
  NotificationChannelType,
  NotificationPriority,
} from "../../types.js";
import type { MacOSNotificationConfig } from "../../config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

const execAsync = promisify(exec);

/**
 * osascript notification options
 */
interface OsascriptOptions {
  title: string;
  message: string;
  subtitle?: string;
  soundName?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Default sound name */
const DEFAULT_SOUND = "Glass";

/** Default notification group */
const DEFAULT_GROUP = "com.clawdbot.pipeline";

/** Priority to urgency mapping */
const PRIORITY_URGENCY: Record<NotificationPriority, string> = {
  low: "low",
  normal: "normal",
  high: "critical",
};

/** Type emoji mapping for titles */
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
// MacOSChannel Implementation
// -----------------------------------------------------------------------------

/**
 * macOS notification channel implementation.
 *
 * Sends notifications via osascript to the macOS Notification Center.
 * Only works on macOS systems.
 */
export class MacOSChannel implements NotificationChannel {
  readonly type: NotificationChannelType = "macos";
  readonly name = "macOS Notifications";

  private readonly config: MacOSNotificationConfig;
  private initialized = false;
  private isMacOS = false;

  constructor(config: MacOSNotificationConfig) {
    this.config = {
      sound: true,
      group: DEFAULT_GROUP,
      ...config,
    };
  }

  /**
   * Check if the channel is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && this.isMacOS;
  }

  /**
   * Initialize the macOS channel
   * Verifies that the current platform is macOS
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Check if running on macOS
    this.isMacOS = platform() === "darwin";

    if (!this.isMacOS && this.config.enabled) {
      // Not an error, just silently disable on non-macOS
      this.initialized = true;
      return;
    }

    // Test that osascript is available
    if (this.isMacOS) {
      try {
        await execAsync("which osascript");
      } catch {
        // osascript not available, disable
        this.isMacOS = false;
      }
    }

    this.initialized = true;
  }

  /**
   * Send a notification to macOS Notification Center
   */
  async send(notification: Notification): Promise<NotificationSendResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        channel: "macos",
        error: this.isMacOS
          ? "macOS channel is not enabled"
          : "macOS notifications only work on macOS",
        retryable: false,
      };
    }

    try {
      const options = this.buildOptions(notification);
      await this.sendNotification(options);

      return {
        success: true,
        channel: "macos",
        sentAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        channel: "macos",
        error: `Failed to send macOS notification: ${message}`,
        retryable: false,
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
   * Build osascript notification options
   */
  private buildOptions(notification: Notification): OsascriptOptions {
    const emoji = TYPE_EMOJI[notification.type] ?? "📢";
    const title = `${emoji} ${notification.title}`;

    // For macOS notifications, use plain text (no markdown)
    const message = notification.message;

    // Build subtitle from metadata
    let subtitle: string | undefined;
    const subtitleParts: string[] = [];

    if (notification.stageId) {
      subtitleParts.push(`Stage: ${notification.stageId}`);
    }

    if (notification.metadata?.provider) {
      subtitleParts.push(`Provider: ${notification.metadata.provider}`);
    }

    if (subtitleParts.length > 0) {
      subtitle = subtitleParts.join(" | ");
    }

    // Determine sound
    let soundName: string | undefined;
    if (this.config.sound) {
      soundName = this.config.soundName ?? DEFAULT_SOUND;

      // Use different sounds for different priorities
      if (notification.priority === "high" && !this.config.soundName) {
        soundName = "Sosumi"; // More attention-grabbing for urgent notifications
      }
    }

    return {
      title,
      message,
      subtitle,
      soundName,
    };
  }

  /**
   * Send notification via osascript
   */
  private async sendNotification(options: OsascriptOptions): Promise<void> {
    const script = this.buildAppleScript(options);

    try {
      await execAsync(`osascript -e '${script}'`);
    } catch (error) {
      // If the simple notification fails, try without sound
      if (options.soundName) {
        const fallbackScript = this.buildAppleScript({
          ...options,
          soundName: undefined,
        });
        await execAsync(`osascript -e '${fallbackScript}'`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Build AppleScript for the notification
   */
  private buildAppleScript(options: OsascriptOptions): string {
    // Escape special characters for AppleScript string
    const escapeForAppleScript = (str: string): string => {
      return str
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/'/g, "'\\''");
    };

    const title = escapeForAppleScript(options.title);
    const message = escapeForAppleScript(options.message);

    let script = `display notification "${message}" with title "${title}"`;

    if (options.subtitle) {
      const subtitle = escapeForAppleScript(options.subtitle);
      script += ` subtitle "${subtitle}"`;
    }

    if (options.soundName) {
      const soundName = escapeForAppleScript(options.soundName);
      script += ` sound name "${soundName}"`;
    }

    return script;
  }
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new macOS channel instance
 *
 * @param config - macOS channel configuration
 * @returns Uninitialized macOS channel instance
 */
export function createMacOSChannel(config: MacOSNotificationConfig): MacOSChannel {
  return new MacOSChannel(config);
}

/**
 * Create and initialize a macOS channel
 *
 * @param config - macOS channel configuration
 * @returns Initialized macOS channel instance
 */
export async function createAndInitializeMacOSChannel(
  config: MacOSNotificationConfig
): Promise<MacOSChannel> {
  const channel = createMacOSChannel(config);
  await channel.initialize();
  return channel;
}
