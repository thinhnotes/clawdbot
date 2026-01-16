import { Type } from "@sinclair/typebox";

/**
 * Pipeline Plugin
 *
 * Multi-stage CI/CD build pipeline with manual approval gates.
 *
 * This plugin provides:
 * - Provider-based design supporting Azure DevOps, GitHub Actions, GitLab CI
 * - State machine for pipeline execution tracking
 * - Approval queue for managing pending stage approvals
 * - Notification hub for multi-channel alerts (Discord, Slack, Telegram, macOS)
 */

// Placeholder types until src/types.ts is implemented
type PipelineConfig = {
  enabled: boolean;
  provider?: string;
};

const pipelineConfigSchema = {
  parse(value: unknown): PipelineConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const provider =
      typeof raw.provider === "string" ? raw.provider : undefined;

    return {
      enabled,
      provider,
    };
  },
  uiHints: {
    enabled: {
      label: "Enabled",
      help: "Enable or disable the pipeline plugin",
    },
    provider: {
      label: "Provider",
      help: "Pipeline provider: azure-devops, github-actions, or gitlab-ci",
    },
    "azureDevops.organization": {
      label: "Azure DevOps Organization",
    },
    "azureDevops.project": {
      label: "Azure DevOps Project",
    },
    "azureDevops.pat": {
      label: "Azure DevOps PAT",
      sensitive: true,
    },
    "notifications.discord.webhookUrl": {
      label: "Discord Webhook URL",
      sensitive: true,
    },
    "notifications.slack.webhookUrl": {
      label: "Slack Webhook URL",
      sensitive: true,
    },
    "notifications.telegram.botToken": {
      label: "Telegram Bot Token",
      sensitive: true,
    },
    "notifications.telegram.chatId": {
      label: "Telegram Chat ID",
    },
    "notifications.macos.enabled": {
      label: "macOS Notifications",
    },
  },
};

const PipelineToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("trigger"),
    pipeline: Type.String({ description: "Pipeline name or ID" }),
    branch: Type.Optional(Type.String({ description: "Branch to build" })),
    parameters: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Pipeline parameters",
      })
    ),
  }),
  Type.Object({
    action: Type.Literal("status"),
    runId: Type.String({ description: "Pipeline run ID" }),
  }),
  Type.Object({
    action: Type.Literal("approve"),
    approvalId: Type.String({ description: "Approval ID" }),
    comment: Type.Optional(Type.String({ description: "Approval comment" })),
  }),
  Type.Object({
    action: Type.Literal("reject"),
    approvalId: Type.String({ description: "Approval ID" }),
    comment: Type.Optional(Type.String({ description: "Rejection reason" })),
  }),
  Type.Object({
    action: Type.Literal("logs"),
    runId: Type.String({ description: "Pipeline run ID" }),
    stage: Type.Optional(Type.String({ description: "Stage name" })),
  }),
  Type.Object({
    action: Type.Literal("history"),
    pipeline: Type.Optional(Type.String({ description: "Pipeline name" })),
    limit: Type.Optional(Type.Number({ description: "Number of runs" })),
  }),
  Type.Object({
    action: Type.Literal("list"),
  }),
  Type.Object({
    action: Type.Literal("pending"),
  }),
]);

const pipelinePlugin = {
  id: "pipeline",
  name: "Pipeline",
  description:
    "Multi-stage CI/CD build pipeline with approval gates supporting Azure DevOps, GitHub Actions, and GitLab CI",
  configSchema: pipelineConfigSchema,
  register(api: {
    pluginConfig: unknown;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    registerGatewayMethod: (name: string, handler: (ctx: { params: unknown; respond: (ok: boolean, payload?: unknown) => void }) => Promise<void>) => void;
    registerTool: (tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (toolCallId: string, params: unknown) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
    }) => void;
    registerCli: (handler: (ctx: { program: unknown }) => void, options: { commands: string[] }) => void;
    registerService: (service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  }) {
    const cfg = pipelineConfigSchema.parse(api.pluginConfig);

    // Runtime will be initialized on first use or service start
    let runtimePromise: Promise<unknown> | null = null;
    let runtime: unknown = null;

    const ensureRuntime = async () => {
      if (!cfg.enabled) {
        throw new Error("Pipeline plugin disabled in config");
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        // Runtime initialization will be implemented in later subtasks
        runtimePromise = Promise.resolve({});
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (
      respond: (ok: boolean, payload?: unknown) => void,
      err: unknown
    ) => {
      respond(false, {
        error: err instanceof Error ? err.message : String(err),
      });
    };

    // Gateway methods will be implemented in subtask 7.3
    api.registerGatewayMethod(
      "pipeline.trigger",
      async ({ params, respond }) => {
        try {
          await ensureRuntime();
          // Implementation pending
          respond(false, { error: "Not yet implemented" });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.status",
      async ({ params, respond }) => {
        try {
          await ensureRuntime();
          // Implementation pending
          respond(false, { error: "Not yet implemented" });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.approve",
      async ({ params, respond }) => {
        try {
          await ensureRuntime();
          // Implementation pending
          respond(false, { error: "Not yet implemented" });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.reject",
      async ({ params, respond }) => {
        try {
          await ensureRuntime();
          // Implementation pending
          respond(false, { error: "Not yet implemented" });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod("pipeline.logs", async ({ params, respond }) => {
      try {
        await ensureRuntime();
        // Implementation pending
        respond(false, { error: "Not yet implemented" });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod(
      "pipeline.pending",
      async ({ params, respond }) => {
        try {
          await ensureRuntime();
          // Implementation pending
          respond(false, { error: "Not yet implemented" });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    // Tool registration - full implementation in subtask 7.1
    api.registerTool({
      name: "pipeline",
      label: "Pipeline",
      description:
        "Manage CI/CD pipelines with multi-stage builds and approval gates",
      parameters: PipelineToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          await ensureRuntime();
          // Implementation pending in subtask 7.1
          return json({ error: "Not yet implemented" });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // CLI registration - implementation in subtask 7.2
    api.registerCli(
      ({ program }) => {
        // CLI commands will be implemented in subtask 7.2
      },
      { commands: ["pipeline"] }
    );

    // Service registration
    api.registerService({
      id: "pipeline",
      start: async () => {
        if (!cfg.enabled) return;
        try {
          await ensureRuntime();
        } catch (err) {
          api.logger.error(
            `[pipeline] Failed to start runtime: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) return;
        try {
          // Cleanup will be implemented with runtime
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default pipelinePlugin;
