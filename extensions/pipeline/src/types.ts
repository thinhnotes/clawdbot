import { z } from "zod";

// -----------------------------------------------------------------------------
// Provider Identifiers
// -----------------------------------------------------------------------------

export const ProviderNameSchema = z.enum([
  "azure-devops",
  "github-actions",
  "gitlab-ci",
  "mock",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// -----------------------------------------------------------------------------
// Core Identifiers
// -----------------------------------------------------------------------------

/** Internal pipeline run identifier (UUID) */
export type PipelineRunId = string;

/** Provider-specific run identifier */
export type ProviderRunId = string;

/** Stage identifier within a pipeline */
export type StageId = string;

/** Approval request identifier */
export type ApprovalId = string;

/** Pipeline definition identifier */
export type PipelineId = string;

// -----------------------------------------------------------------------------
// Pipeline States
// -----------------------------------------------------------------------------

export const PipelineStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const TerminalPipelineStates = new Set<PipelineState>([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

// -----------------------------------------------------------------------------
// Stage States
// -----------------------------------------------------------------------------

export const StageStateSchema = z.enum([
  "pending",
  "queued",
  "running",
  "waiting_for_approval",
  "approved",
  "rejected",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type StageState = z.infer<typeof StageStateSchema>;

export const TerminalStageStates = new Set<StageState>([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "rejected",
]);

// -----------------------------------------------------------------------------
// Approval Types
// -----------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "timeout",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalDecisionSchema = z.enum(["approve", "reject"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  providerRunId: z.string().optional(),
  stageId: z.string(),
  stageName: z.string(),
  pipelineName: z.string(),
  status: ApprovalStatusSchema,
  requestedAt: z.number(),
  expiresAt: z.number().optional(),
  approvers: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  /** Provider-specific approval ID for API calls */
  providerApprovalId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResponseSchema = z.object({
  approvalId: z.string(),
  decision: ApprovalDecisionSchema,
  comment: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.number(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

// -----------------------------------------------------------------------------
// Stage Definition
// -----------------------------------------------------------------------------

export const StageSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  state: StageStateSchema,
  order: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  durationMs: z.number().optional(),
  result: z.enum(["succeeded", "failed", "cancelled", "skipped"]).optional(),
  /** Whether this stage has an approval gate */
  hasApprovalGate: z.boolean().default(false),
  /** Current approval request if waiting */
  approval: ApprovalRequestSchema.optional(),
  /** Jobs within the stage */
  jobs: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        state: StageStateSchema,
        startedAt: z.number().optional(),
        finishedAt: z.number().optional(),
      })
    )
    .optional(),
  /** Error message if failed */
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Stage = z.infer<typeof StageSchema>;

// -----------------------------------------------------------------------------
// Pipeline Run
// -----------------------------------------------------------------------------

export const PipelineRunSchema = z.object({
  id: z.string(),
  providerRunId: z.string().optional(),
  provider: ProviderNameSchema,
  pipelineId: z.string(),
  pipelineName: z.string(),
  state: PipelineStateSchema,
  /** Source branch/ref */
  sourceBranch: z.string().optional(),
  /** Target branch for PRs */
  targetBranch: z.string().optional(),
  /** Commit SHA */
  commitId: z.string().optional(),
  /** Commit message */
  commitMessage: z.string().optional(),
  /** Who triggered the run */
  triggeredBy: z.string().optional(),
  /** How the run was triggered */
  triggerReason: z.string().optional(),
  stages: z.array(StageSchema).default([]),
  parameters: z.record(z.string(), z.string()).optional(),
  queuedAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  durationMs: z.number().optional(),
  /** URL to view the run in provider UI */
  webUrl: z.string().optional(),
  /** Result for terminal states */
  result: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

// -----------------------------------------------------------------------------
// Pipeline Definition
// -----------------------------------------------------------------------------

export const PipelineDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** Folder/path within the provider */
  folder: z.string().optional(),
  /** Default branch */
  defaultBranch: z.string().optional(),
  /** Available parameters */
  parameters: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["string", "boolean", "number"]).default("string"),
        defaultValue: z.string().optional(),
        required: z.boolean().default(false),
      })
    )
    .optional(),
  /** URL to pipeline in provider UI */
  webUrl: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

// -----------------------------------------------------------------------------
// Provider Events
// -----------------------------------------------------------------------------

const BaseProviderEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  providerRunId: z.string().optional(),
  timestamp: z.number(),
});

export const ProviderEventSchema = z.discriminatedUnion("type", [
  BaseProviderEventSchema.extend({
    type: z.literal("pipeline.queued"),
    pipelineName: z.string(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("pipeline.started"),
    pipelineName: z.string(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("pipeline.completed"),
    pipelineName: z.string(),
    result: z.enum(["succeeded", "failed", "cancelled"]),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("stage.started"),
    stageId: z.string(),
    stageName: z.string(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("stage.completed"),
    stageId: z.string(),
    stageName: z.string(),
    result: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("stage.waiting_for_approval"),
    stageId: z.string(),
    stageName: z.string(),
    approvalId: z.string(),
    approvers: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    expiresAt: z.number().optional(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("stage.approval_completed"),
    stageId: z.string(),
    stageName: z.string(),
    approvalId: z.string(),
    decision: ApprovalDecisionSchema,
    approvedBy: z.string().optional(),
    comment: z.string().optional(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("job.started"),
    stageId: z.string().optional(),
    jobId: z.string(),
    jobName: z.string(),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("job.completed"),
    stageId: z.string().optional(),
    jobId: z.string(),
    jobName: z.string(),
    result: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  }),
  BaseProviderEventSchema.extend({
    type: z.literal("error"),
    error: z.string(),
    stageId: z.string().optional(),
    jobId: z.string().optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

// -----------------------------------------------------------------------------
// Webhook Types
// -----------------------------------------------------------------------------

export type WebhookVerificationResult = {
  ok: boolean;
  reason?: string;
};

export type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
};

export type WebhookParseResult = {
  events: ProviderEvent[];
  /** Optional response body to send back to provider */
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  statusCode?: number;
};

// -----------------------------------------------------------------------------
// Provider Input/Output Types
// -----------------------------------------------------------------------------

export type TriggerPipelineInput = {
  pipelineId: string;
  /** Branch to build (optional, uses default if not specified) */
  branch?: string;
  /** Pipeline parameters */
  parameters?: Record<string, string>;
  /** Optional commit/ref to build */
  commitId?: string;
};

export type TriggerPipelineResult = {
  runId: PipelineRunId;
  providerRunId: ProviderRunId;
  webUrl?: string;
  status: "queued" | "running";
};

export type GetPipelineStatusInput = {
  runId: PipelineRunId;
  providerRunId?: ProviderRunId;
};

export type GetLogsInput = {
  runId: PipelineRunId;
  providerRunId?: ProviderRunId;
  /** Specific stage to get logs for */
  stageId?: StageId;
  /** Specific job to get logs for */
  jobId?: string;
};

export type LogEntry = {
  timestamp?: number;
  line: string;
  level?: "info" | "warning" | "error";
};

export type GetLogsResult = {
  logs: LogEntry[];
  /** Whether more logs are available */
  hasMore?: boolean;
  /** Continuation token for pagination */
  continuationToken?: string;
};

export type ApproveStageInput = {
  runId: PipelineRunId;
  providerRunId?: ProviderRunId;
  approvalId: ApprovalId;
  /** Provider-specific approval ID */
  providerApprovalId?: string;
  comment?: string;
};

export type RejectStageInput = {
  runId: PipelineRunId;
  providerRunId?: ProviderRunId;
  approvalId: ApprovalId;
  /** Provider-specific approval ID */
  providerApprovalId?: string;
  comment?: string;
};

export type CancelPipelineInput = {
  runId: PipelineRunId;
  providerRunId?: ProviderRunId;
};

// -----------------------------------------------------------------------------
// Query Types
// -----------------------------------------------------------------------------

export type ListPipelinesResult = {
  pipelines: PipelineDefinition[];
};

export type GetPipelineHistoryInput = {
  pipelineId?: PipelineId;
  limit?: number;
  /** Filter by state */
  state?: PipelineState;
  /** Filter runs after this timestamp */
  after?: number;
  /** Filter runs before this timestamp */
  before?: number;
};

export type GetPipelineHistoryResult = {
  runs: PipelineRun[];
  /** Whether more results are available */
  hasMore?: boolean;
  /** Continuation token for pagination */
  continuationToken?: string;
};

// -----------------------------------------------------------------------------
// Notification Types
// -----------------------------------------------------------------------------

export const NotificationChannelTypeSchema = z.enum([
  "discord",
  "slack",
  "telegram",
  "macos",
]);
export type NotificationChannelType = z.infer<
  typeof NotificationChannelTypeSchema
>;

export const NotificationTypeSchema = z.enum([
  "pipeline_started",
  "pipeline_completed",
  "stage_started",
  "stage_completed",
  "approval_required",
  "approval_completed",
  "pipeline_failed",
  "stage_failed",
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationPrioritySchema = z.enum(["low", "normal", "high"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  type: NotificationTypeSchema,
  priority: NotificationPrioritySchema.default("normal"),
  title: z.string(),
  message: z.string(),
  /** Markdown formatted message (for channels that support it) */
  markdownMessage: z.string().optional(),
  /** Pipeline run associated with this notification */
  runId: z.string().optional(),
  /** Stage associated with this notification */
  stageId: z.string().optional(),
  /** Approval ID if this is an approval notification */
  approvalId: z.string().optional(),
  /** Action buttons (for channels that support them) */
  actions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        style: z.enum(["primary", "secondary", "success", "danger"]).optional(),
        /** URL for link buttons */
        url: z.string().optional(),
      })
    )
    .optional(),
  /** URL to view details in provider UI */
  webUrl: z.string().optional(),
  /** Additional metadata */
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// -----------------------------------------------------------------------------
// Notification Channel Configuration
// -----------------------------------------------------------------------------

export type DiscordChannelConfig = {
  webhookUrl: string;
  /** Optional username to display */
  username?: string;
  /** Optional avatar URL */
  avatarUrl?: string;
};

export type SlackChannelConfig = {
  webhookUrl: string;
  /** Channel to post to (optional, uses webhook default) */
  channel?: string;
  /** Username to display */
  username?: string;
  /** Emoji icon */
  iconEmoji?: string;
};

export type TelegramChannelConfig = {
  botToken: string;
  chatId: string;
  /** Parse mode for messages */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
};

export type MacOSChannelConfig = {
  /** Whether to include sound */
  sound?: boolean;
  /** Notification group identifier */
  group?: string;
};

export type NotificationChannelConfig =
  | { type: "discord"; config: DiscordChannelConfig }
  | { type: "slack"; config: SlackChannelConfig }
  | { type: "telegram"; config: TelegramChannelConfig }
  | { type: "macos"; config: MacOSChannelConfig };

// -----------------------------------------------------------------------------
// Event Emitter Types
// -----------------------------------------------------------------------------

export type PipelineEventMap = {
  "pipeline.queued": PipelineRun;
  "pipeline.started": PipelineRun;
  "pipeline.completed": PipelineRun;
  "stage.started": { run: PipelineRun; stage: Stage };
  "stage.completed": { run: PipelineRun; stage: Stage };
  "stage.waiting_for_approval": { run: PipelineRun; stage: Stage; approval: ApprovalRequest };
  "approval.completed": { run: PipelineRun; stage: Stage; response: ApprovalResponse };
  error: { run?: PipelineRun; error: Error };
};

export type PipelineEventHandler<K extends keyof PipelineEventMap> = (
  event: PipelineEventMap[K]
) => void | Promise<void>;
