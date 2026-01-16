/**
 * Pipeline Configuration Module
 * Provides configuration resolution and default values for the pipeline service.
 */

import type { ClawdbotConfig } from "../config/config.js";
import type {
  ApprovalDefaultsConfig,
  AzureDevOpsConfig,
  PipelineConfig,
} from "../config/types.pipeline.js";

/**
 * Default values for pipeline configuration
 */
export const PIPELINE_DEFAULTS = {
  /** Default enabled state */
  enabled: false,
  /** Default store path (relative to ~/.clawdbot/) */
  store: "~/.clawdbot/pipeline-store.json",
  /** Default max concurrent pipeline runs */
  maxConcurrentRuns: 3,
  /** Default stage timeout: 1 hour */
  defaultTimeoutMs: 60 * 60 * 1000,
  /** Default approval timeout: 24 hours */
  approvalTimeoutMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Default values for Azure DevOps configuration
 */
export const AZDO_DEFAULTS = {
  /** Default polling interval: 30 seconds */
  pollIntervalMs: 30 * 1000,
  /** Default build timeout: 2 hours */
  buildTimeoutMs: 2 * 60 * 60 * 1000,
} as const;

/**
 * Default values for approval configuration
 */
export const APPROVAL_DEFAULTS = {
  /** Default auto-approve on timeout */
  autoApproveOnTimeout: false,
  /** Default auto-reject on timeout */
  autoRejectOnTimeout: false,
  /** Default reminder: 1 hour before timeout */
  reminderBeforeTimeoutMs: 60 * 60 * 1000,
} as const;

/**
 * Resolved pipeline configuration with all defaults applied.
 */
export type ResolvedPipelineConfig = {
  enabled: boolean;
  store: string;
  maxConcurrentRuns: number;
  defaultTimeoutMs: number;
  approvalTimeoutMs: number;
  notificationChannels: string[];
  azureDevOps: ResolvedAzureDevOpsConfig;
  approvals: ResolvedApprovalDefaultsConfig;
};

/**
 * Resolved Azure DevOps configuration with all defaults applied.
 */
export type ResolvedAzureDevOpsConfig = {
  organization: string | undefined;
  project: string | undefined;
  pollIntervalMs: number;
  buildTimeoutMs: number;
};

/**
 * Resolved approval defaults configuration with all defaults applied.
 */
export type ResolvedApprovalDefaultsConfig = {
  approvers: string[];
  autoApproveOnTimeout: boolean;
  autoRejectOnTimeout: boolean;
  reminderBeforeTimeoutMs: number;
};

/**
 * Resolves Azure DevOps configuration with defaults.
 * @param config - Optional Azure DevOps config from user
 * @returns Resolved config with all defaults applied
 */
export function resolveAzureDevOpsConfig(
  config?: AzureDevOpsConfig
): ResolvedAzureDevOpsConfig {
  return {
    organization: config?.organization,
    project: config?.project,
    pollIntervalMs: config?.pollIntervalMs ?? AZDO_DEFAULTS.pollIntervalMs,
    buildTimeoutMs: config?.buildTimeoutMs ?? AZDO_DEFAULTS.buildTimeoutMs,
  };
}

/**
 * Resolves approval defaults configuration with defaults.
 * @param config - Optional approval defaults config from user
 * @returns Resolved config with all defaults applied
 */
export function resolveApprovalDefaultsConfig(
  config?: ApprovalDefaultsConfig
): ResolvedApprovalDefaultsConfig {
  return {
    approvers: config?.approvers ?? [],
    autoApproveOnTimeout:
      config?.autoApproveOnTimeout ?? APPROVAL_DEFAULTS.autoApproveOnTimeout,
    autoRejectOnTimeout:
      config?.autoRejectOnTimeout ?? APPROVAL_DEFAULTS.autoRejectOnTimeout,
    reminderBeforeTimeoutMs:
      config?.reminderBeforeTimeoutMs ??
      APPROVAL_DEFAULTS.reminderBeforeTimeoutMs,
  };
}

/**
 * Resolves pipeline configuration with all defaults applied.
 * @param config - Optional pipeline config from user
 * @returns Resolved config with all defaults applied
 */
export function resolvePipelineConfig(
  config?: PipelineConfig
): ResolvedPipelineConfig {
  return {
    enabled: config?.enabled ?? PIPELINE_DEFAULTS.enabled,
    store: config?.store ?? PIPELINE_DEFAULTS.store,
    maxConcurrentRuns:
      config?.maxConcurrentRuns ?? PIPELINE_DEFAULTS.maxConcurrentRuns,
    defaultTimeoutMs:
      config?.defaultTimeoutMs ?? PIPELINE_DEFAULTS.defaultTimeoutMs,
    approvalTimeoutMs:
      config?.approvalTimeoutMs ?? PIPELINE_DEFAULTS.approvalTimeoutMs,
    notificationChannels: config?.notificationChannels ?? [],
    azureDevOps: resolveAzureDevOpsConfig(config?.azureDevOps),
    approvals: resolveApprovalDefaultsConfig(config?.approvals),
  };
}

/**
 * Extracts and resolves pipeline configuration from ClawdbotConfig.
 * @param config - Optional ClawdbotConfig
 * @returns Resolved pipeline config with all defaults applied
 */
export function resolvePipelineConfigFromClawdbot(
  config?: ClawdbotConfig
): ResolvedPipelineConfig {
  return resolvePipelineConfig(config?.pipeline);
}

/**
 * Checks if the pipeline service is enabled in the given configuration.
 * @param config - Optional ClawdbotConfig
 * @returns true if pipeline service is enabled
 */
export function isPipelineEnabled(config?: ClawdbotConfig): boolean {
  return config?.pipeline?.enabled ?? PIPELINE_DEFAULTS.enabled;
}

/**
 * Gets the pipeline store path from configuration.
 * @param config - Optional ClawdbotConfig
 * @returns The store path (may contain ~ for home directory)
 */
export function getPipelineStorePath(config?: ClawdbotConfig): string {
  return config?.pipeline?.store ?? PIPELINE_DEFAULTS.store;
}

/**
 * Validates pipeline configuration and returns any issues.
 * @param config - Pipeline configuration to validate
 * @returns Array of validation issue messages (empty if valid)
 */
export function validatePipelineConfig(config?: PipelineConfig): string[] {
  const issues: string[] = [];

  if (config?.maxConcurrentRuns !== undefined) {
    if (
      !Number.isInteger(config.maxConcurrentRuns) ||
      config.maxConcurrentRuns < 1
    ) {
      issues.push("pipeline.maxConcurrentRuns must be a positive integer");
    }
  }

  if (config?.defaultTimeoutMs !== undefined) {
    if (
      !Number.isInteger(config.defaultTimeoutMs) ||
      config.defaultTimeoutMs < 1000
    ) {
      issues.push(
        "pipeline.defaultTimeoutMs must be a positive integer >= 1000ms"
      );
    }
  }

  if (config?.approvalTimeoutMs !== undefined) {
    if (
      !Number.isInteger(config.approvalTimeoutMs) ||
      config.approvalTimeoutMs < 1000
    ) {
      issues.push(
        "pipeline.approvalTimeoutMs must be a positive integer >= 1000ms"
      );
    }
  }

  if (config?.notificationChannels !== undefined) {
    for (const channel of config.notificationChannels) {
      if (!channel.includes(":")) {
        issues.push(
          `pipeline.notificationChannels: "${channel}" should be in format "channel:recipient"`
        );
      }
    }
  }

  if (config?.azureDevOps?.pollIntervalMs !== undefined) {
    if (
      !Number.isInteger(config.azureDevOps.pollIntervalMs) ||
      config.azureDevOps.pollIntervalMs < 1000
    ) {
      issues.push(
        "pipeline.azureDevOps.pollIntervalMs must be a positive integer >= 1000ms"
      );
    }
  }

  if (config?.azureDevOps?.buildTimeoutMs !== undefined) {
    if (
      !Number.isInteger(config.azureDevOps.buildTimeoutMs) ||
      config.azureDevOps.buildTimeoutMs < 1000
    ) {
      issues.push(
        "pipeline.azureDevOps.buildTimeoutMs must be a positive integer >= 1000ms"
      );
    }
  }

  if (config?.approvals?.reminderBeforeTimeoutMs !== undefined) {
    if (
      !Number.isInteger(config.approvals.reminderBeforeTimeoutMs) ||
      config.approvals.reminderBeforeTimeoutMs < 0
    ) {
      issues.push(
        "pipeline.approvals.reminderBeforeTimeoutMs must be a non-negative integer"
      );
    }
  }

  // Validate that auto-approve and auto-reject are not both true
  if (
    config?.approvals?.autoApproveOnTimeout === true &&
    config?.approvals?.autoRejectOnTimeout === true
  ) {
    issues.push(
      "pipeline.approvals: cannot set both autoApproveOnTimeout and autoRejectOnTimeout to true"
    );
  }

  return issues;
}

/**
 * Creates a default stage approval configuration based on pipeline defaults.
 * @param pipelineConfig - Resolved pipeline configuration
 * @returns Approval config for use in stage creation
 */
export function createDefaultApprovalConfig(
  pipelineConfig: ResolvedPipelineConfig
): {
  required: boolean;
  approvers: string[];
  timeoutMs: number;
  autoApprove: boolean;
  autoReject: boolean;
} {
  return {
    required: false,
    approvers: pipelineConfig.approvals.approvers,
    timeoutMs: pipelineConfig.approvalTimeoutMs,
    autoApprove: pipelineConfig.approvals.autoApproveOnTimeout,
    autoReject: pipelineConfig.approvals.autoRejectOnTimeout,
  };
}

/**
 * Creates Azure DevOps stage executor config from pipeline defaults.
 * @param pipelineConfig - Resolved pipeline configuration
 * @param options - Stage-specific overrides
 * @returns Azure DevOps executor configuration
 */
export function createAzDoExecutorConfig(
  pipelineConfig: ResolvedPipelineConfig,
  options: {
    pipelineId: string;
    organization?: string;
    project?: string;
  }
): {
  kind: "azdo";
  organization: string;
  project: string;
  pipelineId: string;
} {
  const org =
    options.organization ?? pipelineConfig.azureDevOps.organization ?? "";
  const proj = options.project ?? pipelineConfig.azureDevOps.project ?? "";

  if (!org) {
    throw new Error(
      "Azure DevOps organization is required. Set it in pipeline.azureDevOps.organization or provide it per-stage."
    );
  }
  if (!proj) {
    throw new Error(
      "Azure DevOps project is required. Set it in pipeline.azureDevOps.project or provide it per-stage."
    );
  }

  return {
    kind: "azdo",
    organization: org,
    project: proj,
    pipelineId: options.pipelineId,
  };
}
