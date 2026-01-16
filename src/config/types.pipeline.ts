/**
 * Pipeline Configuration
 * Configuration for the multi-stage build pipeline service.
 */
export type PipelineConfig = {
  /** Whether the pipeline service is enabled. Defaults to false. */
  enabled?: boolean;
  /** Path to the pipeline store JSON file. Defaults to ~/.clawdbot/pipeline-store.json */
  store?: string;
  /** Maximum number of concurrent pipeline runs. Defaults to 3. */
  maxConcurrentRuns?: number;
  /** Default timeout for pipeline stages in milliseconds. Defaults to 1 hour. */
  defaultTimeoutMs?: number;
  /** Default timeout for approval requests in milliseconds. Defaults to 24 hours. */
  approvalTimeoutMs?: number;
  /** Default notification channels for pipeline events (e.g., "discord:channel-id", "slack:channel-id") */
  notificationChannels?: string[];
  /** Azure DevOps default settings */
  azureDevOps?: AzureDevOpsConfig;
  /** Approval settings */
  approvals?: ApprovalDefaultsConfig;
};

/**
 * Azure DevOps Configuration
 * Default settings for Azure DevOps pipeline integration.
 */
export type AzureDevOpsConfig = {
  /** Default organization name */
  organization?: string;
  /** Default project name */
  project?: string;
  /** Polling interval for build status in milliseconds. Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Maximum wait time for builds in milliseconds. Defaults to 2 hours. */
  buildTimeoutMs?: number;
};

/**
 * Approval Defaults Configuration
 * Default settings for pipeline approval workflow.
 */
export type ApprovalDefaultsConfig = {
  /** Default list of approvers (user IDs or roles) */
  approvers?: string[];
  /** Whether to auto-approve on timeout. Defaults to false. */
  autoApproveOnTimeout?: boolean;
  /** Whether to auto-reject on timeout. Defaults to false. */
  autoRejectOnTimeout?: boolean;
  /** Reminder interval in milliseconds before approval timeout. Defaults to 1 hour before. */
  reminderBeforeTimeoutMs?: number;
};
