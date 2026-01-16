import { z } from "zod";
import { ProviderNameSchema, NotificationTypeSchema } from "./types";

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

export const AzureDevOpsConfigSchema = z.object({
  /** Azure DevOps organization name (e.g., "myorg") */
  organization: z.string().min(1).optional(),
  /** Azure DevOps project name */
  project: z.string().min(1).optional(),
  /** Personal Access Token with pipeline permissions */
  pat: z.string().min(1).optional(),
  /** API version to use (default: 7.0) */
  apiVersion: z.string().min(1).default("7.0"),
  /** Base URL override (for on-premises installations) */
  baseUrl: z.string().url().optional(),
});
export type AzureDevOpsConfig = z.infer<typeof AzureDevOpsConfigSchema>;

export const GitHubActionsConfigSchema = z.object({
  /** GitHub personal access token or fine-grained token */
  token: z.string().min(1).optional(),
  /** Repository owner (organization or user) */
  owner: z.string().min(1).optional(),
  /** Repository name */
  repo: z.string().min(1).optional(),
  /** GitHub API base URL (for GitHub Enterprise) */
  baseUrl: z.string().url().optional(),
});
export type GitHubActionsConfig = z.infer<typeof GitHubActionsConfigSchema>;

export const GitLabCIConfigSchema = z.object({
  /** GitLab personal access token or project token */
  token: z.string().min(1).optional(),
  /** GitLab project ID or path (e.g., "group/project") */
  projectId: z.string().min(1).optional(),
  /** GitLab API base URL (default: https://gitlab.com) */
  baseUrl: z.string().url().default("https://gitlab.com"),
});
export type GitLabCIConfig = z.infer<typeof GitLabCIConfigSchema>;

export const MockProviderConfigSchema = z.object({
  /** Simulated delay range in ms [min, max] */
  delayRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).default([1000, 5000]),
  /** Simulated failure rate (0-1) */
  failureRate: z.number().min(0).max(1).default(0),
  /** Number of stages to simulate */
  stageCount: z.number().int().positive().default(3),
  /** Stages that require approval (by index, 0-based) */
  approvalStages: z.array(z.number().int().nonnegative()).default([1]),
});
export type MockProviderConfig = z.infer<typeof MockProviderConfigSchema>;

// -----------------------------------------------------------------------------
// Notification Channel Configuration
// -----------------------------------------------------------------------------

export const DiscordNotificationConfigSchema = z.object({
  /** Enable Discord notifications */
  enabled: z.boolean().default(false),
  /** Discord webhook URL */
  webhookUrl: z.string().url().optional(),
  /** Bot username to display */
  username: z.string().min(1).optional(),
  /** Bot avatar URL */
  avatarUrl: z.string().url().optional(),
  /** Thread ID to post in (optional) */
  threadId: z.string().min(1).optional(),
});
export type DiscordNotificationConfig = z.infer<typeof DiscordNotificationConfigSchema>;

export const SlackNotificationConfigSchema = z.object({
  /** Enable Slack notifications */
  enabled: z.boolean().default(false),
  /** Slack webhook URL */
  webhookUrl: z.string().url().optional(),
  /** Channel to post to (optional, uses webhook default) */
  channel: z.string().min(1).optional(),
  /** Bot username to display */
  username: z.string().min(1).optional(),
  /** Emoji icon (e.g., ":rocket:") */
  iconEmoji: z.string().min(1).optional(),
  /** Icon URL (overrides iconEmoji if set) */
  iconUrl: z.string().url().optional(),
});
export type SlackNotificationConfig = z.infer<typeof SlackNotificationConfigSchema>;

export const TelegramNotificationConfigSchema = z.object({
  /** Enable Telegram notifications */
  enabled: z.boolean().default(false),
  /** Telegram bot token from @BotFather */
  botToken: z.string().min(1).optional(),
  /** Chat ID to send messages to */
  chatId: z.string().min(1).optional(),
  /** Parse mode for messages */
  parseMode: z.enum(["Markdown", "MarkdownV2", "HTML"]).default("HTML"),
  /** Disable link previews */
  disableWebPagePreview: z.boolean().default(false),
  /** Disable notification sound */
  disableNotification: z.boolean().default(false),
});
export type TelegramNotificationConfig = z.infer<typeof TelegramNotificationConfigSchema>;

export const MacOSNotificationConfigSchema = z.object({
  /** Enable macOS notifications */
  enabled: z.boolean().default(false),
  /** Play sound with notifications */
  sound: z.boolean().default(true),
  /** Sound name (e.g., "Glass", "Ping", "Pop") */
  soundName: z.string().min(1).optional(),
  /** Notification group identifier for grouping */
  group: z.string().min(1).default("com.clawdbot.pipeline"),
});
export type MacOSNotificationConfig = z.infer<typeof MacOSNotificationConfigSchema>;

export const NotificationSettingsSchema = z.object({
  /** Discord notification settings */
  discord: DiscordNotificationConfigSchema.default({}),
  /** Slack notification settings */
  slack: SlackNotificationConfigSchema.default({}),
  /** Telegram notification settings */
  telegram: TelegramNotificationConfigSchema.default({}),
  /** macOS notification settings */
  macos: MacOSNotificationConfigSchema.default({}),
  /** Notification types to send (defaults to all) */
  enabledTypes: z.array(NotificationTypeSchema).optional(),
  /** Notification types to suppress */
  suppressedTypes: z.array(NotificationTypeSchema).default([]),
  /** Only notify on failures */
  onlyOnFailure: z.boolean().default(false),
  /** Include stage-level notifications (more verbose) */
  includeStageNotifications: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const PipelineWebhookConfigSchema = z.object({
  /** Enable webhook server for receiving provider events */
  enabled: z.boolean().default(false),
  /** Port to listen on */
  port: z.number().int().positive().default(3335),
  /** Bind address */
  bind: z.string().default("127.0.0.1"),
  /** Webhook path */
  path: z.string().min(1).default("/pipeline/webhook"),
  /** Secret for webhook signature verification */
  secret: z.string().min(1).optional(),
});
export type PipelineWebhookConfig = z.infer<typeof PipelineWebhookConfigSchema>;

// -----------------------------------------------------------------------------
// Polling Configuration
// -----------------------------------------------------------------------------

export const PipelinePollingConfigSchema = z.object({
  /** Enable status polling (alternative to webhooks) */
  enabled: z.boolean().default(true),
  /** Polling interval in milliseconds */
  intervalMs: z.number().int().positive().default(15000),
  /** Fast polling interval during active runs */
  fastIntervalMs: z.number().int().positive().default(5000),
  /** Maximum polling duration before giving up (ms) */
  maxDurationMs: z.number().int().positive().default(7200000), // 2 hours
});
export type PipelinePollingConfig = z.infer<typeof PipelinePollingConfigSchema>;

// -----------------------------------------------------------------------------
// Store Configuration
// -----------------------------------------------------------------------------

export const PipelineStoreConfigSchema = z.object({
  /** Storage type */
  type: z.enum(["memory", "file"]).default("memory"),
  /** File path for persistent storage (when type is "file") */
  filePath: z.string().min(1).optional(),
  /** Maximum number of runs to retain in history */
  maxHistorySize: z.number().int().positive().default(100),
  /** Maximum age of runs to retain (ms, 0 = no limit) */
  maxHistoryAgeMs: z.number().int().nonnegative().default(604800000), // 7 days
});
export type PipelineStoreConfig = z.infer<typeof PipelineStoreConfigSchema>;

// -----------------------------------------------------------------------------
// Approval Configuration
// -----------------------------------------------------------------------------

export const ApprovalConfigSchema = z.object({
  /** Default timeout for approval requests (ms) */
  defaultTimeoutMs: z.number().int().positive().default(3600000), // 1 hour
  /** Authorized approvers (user IDs or patterns, empty = anyone) */
  authorizedApprovers: z.array(z.string().min(1)).default([]),
  /** Require comment for rejections */
  requireRejectComment: z.boolean().default(false),
  /** Auto-reject on timeout */
  autoRejectOnTimeout: z.boolean().default(false),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

// -----------------------------------------------------------------------------
// Main Pipeline Configuration
// -----------------------------------------------------------------------------

export const PipelineConfigSchema = z.object({
  /** Enable pipeline functionality */
  enabled: z.boolean().default(false),

  /** Active provider */
  provider: ProviderNameSchema.optional(),

  /** Azure DevOps configuration */
  azureDevops: AzureDevOpsConfigSchema.optional(),

  /** GitHub Actions configuration */
  githubActions: GitHubActionsConfigSchema.optional(),

  /** GitLab CI configuration */
  gitlabCi: GitLabCIConfigSchema.optional(),

  /** Mock provider configuration (for testing) */
  mock: MockProviderConfigSchema.optional(),

  /** Default pipeline to use if not specified */
  defaultPipeline: z.string().min(1).optional(),

  /** Default branch to use if not specified */
  defaultBranch: z.string().min(1).optional(),

  /** Notification settings */
  notifications: NotificationSettingsSchema.default({}),

  /** Webhook server configuration */
  webhook: PipelineWebhookConfigSchema.default({}),

  /** Status polling configuration */
  polling: PipelinePollingConfigSchema.default({}),

  /** Pipeline run storage configuration */
  store: PipelineStoreConfigSchema.default({}),

  /** Approval workflow configuration */
  approval: ApprovalConfigSchema.default({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

/**
 * Validate that the configuration has all required fields for the selected provider.
 */
export function validateProviderConfig(config: PipelineConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.provider) {
    errors.push("plugins.entries.pipeline.config.provider is required when enabled");
  }

  if (config.provider === "azure-devops") {
    if (!config.azureDevops?.organization) {
      errors.push(
        "plugins.entries.pipeline.config.azureDevops.organization is required (or set AZURE_DEVOPS_ORG env)",
      );
    }
    if (!config.azureDevops?.project) {
      errors.push(
        "plugins.entries.pipeline.config.azureDevops.project is required (or set AZURE_DEVOPS_PROJECT env)",
      );
    }
    if (!config.azureDevops?.pat) {
      errors.push(
        "plugins.entries.pipeline.config.azureDevops.pat is required (or set AZURE_DEVOPS_PAT env)",
      );
    }
  }

  if (config.provider === "github-actions") {
    if (!config.githubActions?.token) {
      errors.push(
        "plugins.entries.pipeline.config.githubActions.token is required (or set GITHUB_TOKEN env)",
      );
    }
    if (!config.githubActions?.owner) {
      errors.push(
        "plugins.entries.pipeline.config.githubActions.owner is required",
      );
    }
    if (!config.githubActions?.repo) {
      errors.push(
        "plugins.entries.pipeline.config.githubActions.repo is required",
      );
    }
  }

  if (config.provider === "gitlab-ci") {
    if (!config.gitlabCi?.token) {
      errors.push(
        "plugins.entries.pipeline.config.gitlabCi.token is required (or set GITLAB_TOKEN env)",
      );
    }
    if (!config.gitlabCi?.projectId) {
      errors.push(
        "plugins.entries.pipeline.config.gitlabCi.projectId is required",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate notification channel configuration.
 */
export function validateNotificationConfig(config: PipelineConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const notifications = config.notifications;

  if (notifications.discord.enabled && !notifications.discord.webhookUrl) {
    errors.push(
      "plugins.entries.pipeline.config.notifications.discord.webhookUrl is required when Discord is enabled",
    );
  }

  if (notifications.slack.enabled && !notifications.slack.webhookUrl) {
    errors.push(
      "plugins.entries.pipeline.config.notifications.slack.webhookUrl is required when Slack is enabled",
    );
  }

  if (notifications.telegram.enabled) {
    if (!notifications.telegram.botToken) {
      errors.push(
        "plugins.entries.pipeline.config.notifications.telegram.botToken is required when Telegram is enabled",
      );
    }
    if (!notifications.telegram.chatId) {
      errors.push(
        "plugins.entries.pipeline.config.notifications.telegram.chatId is required when Telegram is enabled",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Combined validation for all configuration.
 */
export function validateConfig(config: PipelineConfig): {
  valid: boolean;
  errors: string[];
} {
  const providerResult = validateProviderConfig(config);
  const notificationResult = validateNotificationConfig(config);

  return {
    valid: providerResult.valid && notificationResult.valid,
    errors: [...providerResult.errors, ...notificationResult.errors],
  };
}

// -----------------------------------------------------------------------------
// UI Hints for Configuration Fields
// -----------------------------------------------------------------------------

export const pipelineConfigUiHints = {
  enabled: {
    label: "Enabled",
    help: "Enable or disable the pipeline plugin",
  },
  provider: {
    label: "Provider",
    help: "Pipeline provider: azure-devops, github-actions, gitlab-ci, or mock",
  },

  // Azure DevOps
  "azureDevops.organization": {
    label: "Azure DevOps Organization",
    help: "Your Azure DevOps organization name",
  },
  "azureDevops.project": {
    label: "Azure DevOps Project",
    help: "Your Azure DevOps project name",
  },
  "azureDevops.pat": {
    label: "Azure DevOps PAT",
    help: "Personal Access Token with Build (read & execute) scope",
    sensitive: true,
  },
  "azureDevops.apiVersion": {
    label: "Azure DevOps API Version",
    help: "API version to use (default: 7.0)",
  },
  "azureDevops.baseUrl": {
    label: "Azure DevOps Base URL",
    help: "Base URL for on-premises Azure DevOps Server",
  },

  // GitHub Actions
  "githubActions.token": {
    label: "GitHub Token",
    help: "Personal access token or fine-grained token with workflow permissions",
    sensitive: true,
  },
  "githubActions.owner": {
    label: "GitHub Owner",
    help: "Repository owner (organization or username)",
  },
  "githubActions.repo": {
    label: "GitHub Repository",
    help: "Repository name",
  },
  "githubActions.baseUrl": {
    label: "GitHub API URL",
    help: "Base URL for GitHub Enterprise",
  },

  // GitLab CI
  "gitlabCi.token": {
    label: "GitLab Token",
    help: "Personal access token or project token with pipeline permissions",
    sensitive: true,
  },
  "gitlabCi.projectId": {
    label: "GitLab Project ID",
    help: "Project ID or path (e.g., 'group/project')",
  },
  "gitlabCi.baseUrl": {
    label: "GitLab API URL",
    help: "Base URL for self-hosted GitLab",
  },

  // Notifications - Discord
  "notifications.discord.enabled": {
    label: "Discord Notifications",
    help: "Enable Discord notifications",
  },
  "notifications.discord.webhookUrl": {
    label: "Discord Webhook URL",
    help: "Discord webhook URL for notifications",
    sensitive: true,
  },
  "notifications.discord.username": {
    label: "Discord Username",
    help: "Bot username to display in Discord",
  },
  "notifications.discord.avatarUrl": {
    label: "Discord Avatar URL",
    help: "Bot avatar URL for Discord",
  },

  // Notifications - Slack
  "notifications.slack.enabled": {
    label: "Slack Notifications",
    help: "Enable Slack notifications",
  },
  "notifications.slack.webhookUrl": {
    label: "Slack Webhook URL",
    help: "Slack incoming webhook URL",
    sensitive: true,
  },
  "notifications.slack.channel": {
    label: "Slack Channel",
    help: "Channel to post to (uses webhook default if not set)",
  },
  "notifications.slack.username": {
    label: "Slack Username",
    help: "Bot username to display in Slack",
  },
  "notifications.slack.iconEmoji": {
    label: "Slack Icon Emoji",
    help: "Emoji icon for the bot (e.g., ':rocket:')",
  },

  // Notifications - Telegram
  "notifications.telegram.enabled": {
    label: "Telegram Notifications",
    help: "Enable Telegram notifications",
  },
  "notifications.telegram.botToken": {
    label: "Telegram Bot Token",
    help: "Telegram bot token from @BotFather",
    sensitive: true,
  },
  "notifications.telegram.chatId": {
    label: "Telegram Chat ID",
    help: "Chat ID to send notifications to",
  },
  "notifications.telegram.parseMode": {
    label: "Telegram Parse Mode",
    help: "Message format: HTML, Markdown, or MarkdownV2",
  },

  // Notifications - macOS
  "notifications.macos.enabled": {
    label: "macOS Notifications",
    help: "Enable macOS native notifications",
  },
  "notifications.macos.sound": {
    label: "macOS Sound",
    help: "Play sound with notifications",
  },
  "notifications.macos.soundName": {
    label: "macOS Sound Name",
    help: "Sound name (e.g., Glass, Ping, Pop)",
  },
  "notifications.macos.group": {
    label: "macOS Notification Group",
    help: "Notification group identifier",
  },

  // Notification Settings
  "notifications.onlyOnFailure": {
    label: "Only On Failure",
    help: "Only send notifications when pipelines fail",
  },
  "notifications.includeStageNotifications": {
    label: "Stage Notifications",
    help: "Include stage-level notifications (more verbose)",
  },

  // Webhook
  "webhook.enabled": {
    label: "Webhook Server",
    help: "Enable webhook server for provider events",
  },
  "webhook.port": {
    label: "Webhook Port",
    help: "Port for webhook server",
  },
  "webhook.bind": {
    label: "Webhook Bind Address",
    help: "Address to bind webhook server to",
  },
  "webhook.path": {
    label: "Webhook Path",
    help: "URL path for webhook endpoint",
  },
  "webhook.secret": {
    label: "Webhook Secret",
    help: "Secret for webhook signature verification",
    sensitive: true,
  },

  // Polling
  "polling.enabled": {
    label: "Status Polling",
    help: "Enable status polling (alternative to webhooks)",
  },
  "polling.intervalMs": {
    label: "Polling Interval",
    help: "Polling interval in milliseconds",
  },
  "polling.fastIntervalMs": {
    label: "Fast Polling Interval",
    help: "Fast polling interval during active runs",
  },

  // Store
  "store.type": {
    label: "Storage Type",
    help: "Storage type: memory or file",
  },
  "store.filePath": {
    label: "Storage File Path",
    help: "File path for persistent storage",
  },
  "store.maxHistorySize": {
    label: "Max History Size",
    help: "Maximum number of runs to retain",
  },

  // Approval
  "approval.defaultTimeoutMs": {
    label: "Approval Timeout",
    help: "Default timeout for approval requests in milliseconds",
  },
  "approval.requireRejectComment": {
    label: "Require Reject Comment",
    help: "Require a comment when rejecting approvals",
  },
  "approval.autoRejectOnTimeout": {
    label: "Auto-Reject on Timeout",
    help: "Automatically reject approvals when they timeout",
  },

  // General
  defaultPipeline: {
    label: "Default Pipeline",
    help: "Default pipeline to use if not specified",
  },
  defaultBranch: {
    label: "Default Branch",
    help: "Default branch to use if not specified",
  },
} as const;

export type PipelineConfigUiHints = typeof pipelineConfigUiHints;

// -----------------------------------------------------------------------------
// Parse Function for Plugin Integration
// -----------------------------------------------------------------------------

/**
 * Parse and validate pipeline configuration with defaults.
 */
export function parsePipelineConfig(value: unknown): PipelineConfig {
  return PipelineConfigSchema.parse(value ?? {});
}

/**
 * Safe parse that returns result object instead of throwing.
 */
export function safeParsePipelineConfig(value: unknown): z.SafeParseReturnType<unknown, PipelineConfig> {
  return PipelineConfigSchema.safeParse(value ?? {});
}
