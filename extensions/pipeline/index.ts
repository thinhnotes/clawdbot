import { Type } from "@sinclair/typebox";

import {
  PipelineConfigSchema,
  validateConfig,
  pipelineConfigUiHints,
  type PipelineConfig,
} from "./src/config.js";
import {
  createPipelineRuntime,
  type PipelineRuntime,
} from "./src/runtime.js";

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

// -----------------------------------------------------------------------------
// Configuration Schema
// -----------------------------------------------------------------------------

const pipelineConfigSchema = {
  parse(value: unknown): PipelineConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return PipelineConfigSchema.parse(raw);
  },
  uiHints: pipelineConfigUiHints,
};

// -----------------------------------------------------------------------------
// Tool Schema
// -----------------------------------------------------------------------------

/**
 * Tool schema for LLM access to pipeline operations.
 * Supports multiple actions: trigger, status, approve, reject, logs, history, list, pending
 */
const PipelineToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("trigger"),
    pipeline: Type.String({ description: "Pipeline name or ID to trigger" }),
    branch: Type.Optional(Type.String({ description: "Branch to build (uses default if not specified)" })),
    parameters: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Pipeline parameters as key-value pairs",
      })
    ),
  }),
  Type.Object({
    action: Type.Literal("status"),
    runId: Type.String({ description: "Pipeline run ID to check status for" }),
    refresh: Type.Optional(Type.Boolean({ description: "Refresh status from provider (default: false)" })),
  }),
  Type.Object({
    action: Type.Literal("approve"),
    approvalId: Type.String({ description: "Approval ID to approve" }),
    comment: Type.Optional(Type.String({ description: "Approval comment" })),
  }),
  Type.Object({
    action: Type.Literal("reject"),
    approvalId: Type.String({ description: "Approval ID to reject" }),
    comment: Type.Optional(Type.String({ description: "Rejection reason (may be required by configuration)" })),
  }),
  Type.Object({
    action: Type.Literal("logs"),
    runId: Type.String({ description: "Pipeline run ID to get logs for" }),
    stage: Type.Optional(Type.String({ description: "Stage name or ID to get logs for (returns all if not specified)" })),
  }),
  Type.Object({
    action: Type.Literal("history"),
    pipeline: Type.Optional(Type.String({ description: "Filter by pipeline name or ID" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of runs to return (default: 10)" })),
    state: Type.Optional(Type.String({ description: "Filter by state: queued, running, waiting_for_approval, succeeded, failed, cancelled" })),
  }),
  Type.Object({
    action: Type.Literal("list"),
  }),
  Type.Object({
    action: Type.Literal("pending"),
  }),
  Type.Object({
    action: Type.Literal("cancel"),
    runId: Type.String({ description: "Pipeline run ID to cancel" }),
  }),
]);

// -----------------------------------------------------------------------------
// Plugin Definition
// -----------------------------------------------------------------------------

const pipelinePlugin = {
  id: "pipeline",
  name: "Pipeline",
  description:
    "Multi-stage CI/CD build pipeline with approval gates supporting Azure DevOps, GitHub Actions, and GitLab CI",
  configSchema: pipelineConfigSchema,
  register(api: {
    pluginConfig: unknown;
    config: unknown;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    registerGatewayMethod: (name: string, handler: (ctx: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown) => void }) => Promise<void>) => void;
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

    // Validate configuration
    const validation = validateConfig(cfg);
    if (!validation.valid && cfg.enabled) {
      for (const error of validation.errors) {
        api.logger.warn(`[pipeline] Config warning: ${error}`);
      }
    }

    // Runtime will be initialized on first use or service start
    let runtimePromise: Promise<PipelineRuntime> | null = null;
    let runtime: PipelineRuntime | null = null;

    const ensureRuntime = async (): Promise<PipelineRuntime> => {
      if (!cfg.enabled) {
        throw new Error("Pipeline plugin disabled in config");
      }
      if (!validation.valid) {
        throw new Error(`Configuration invalid: ${validation.errors.join("; ")}`);
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createPipelineRuntime(cfg, {
          logger: api.logger,
        });
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

    const sendSuccess = (
      respond: (ok: boolean, payload?: unknown) => void,
      payload: unknown
    ) => {
      respond(true, payload);
    };

    // -------------------------------------------------------------------------
    // Gateway Methods (for programmatic access)
    // -------------------------------------------------------------------------

    api.registerGatewayMethod(
      "pipeline.trigger",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const pipelineId = typeof params?.pipeline === "string" ? params.pipeline.trim() : "";
          if (!pipelineId) {
            respond(false, { error: "pipeline is required" });
            return;
          }
          const result = await rt.manager.triggerPipeline({
            pipelineId,
            branch: typeof params?.branch === "string" ? params.branch.trim() : undefined,
            parameters: params?.parameters as Record<string, string> | undefined,
          });
          sendSuccess(respond, {
            runId: result.runId,
            providerRunId: result.providerRunId,
            webUrl: result.webUrl,
            state: result.run.state,
            pipelineName: result.run.pipelineName,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.status",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
          if (!runId) {
            respond(false, { error: "runId is required" });
            return;
          }
          const refresh = params?.refresh === true;
          const run = await rt.manager.getStatus({ runId, refresh });
          if (!run) {
            respond(true, { found: false, runId });
            return;
          }
          sendSuccess(respond, {
            found: true,
            run: {
              id: run.id,
              providerRunId: run.providerRunId,
              state: run.state,
              result: run.result,
              pipelineId: run.pipelineId,
              pipelineName: run.pipelineName,
              sourceBranch: run.sourceBranch,
              webUrl: run.webUrl,
              queuedAt: run.queuedAt,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              durationMs: run.durationMs,
              stages: run.stages.map((s) => ({
                id: s.id,
                name: s.name,
                state: s.state,
                result: s.result,
              })),
            },
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.approve",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId.trim() : "";
          if (!approvalId) {
            respond(false, { error: "approvalId is required" });
            return;
          }
          const result = await rt.manager.approve(approvalId, {
            comment: typeof params?.comment === "string" ? params.comment : undefined,
          });
          sendSuccess(respond, {
            success: result.success,
            approvalId: result.approvalId,
            decision: result.decision,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.reject",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId.trim() : "";
          if (!approvalId) {
            respond(false, { error: "approvalId is required" });
            return;
          }
          const result = await rt.manager.reject(approvalId, {
            comment: typeof params?.comment === "string" ? params.comment : undefined,
          });
          sendSuccess(respond, {
            success: result.success,
            approvalId: result.approvalId,
            decision: result.decision,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod("pipeline.logs", async ({ params, respond }) => {
      try {
        const rt = await ensureRuntime();
        const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
        if (!runId) {
          respond(false, { error: "runId is required" });
          return;
        }
        const stageId = typeof params?.stage === "string" ? params.stage.trim() : undefined;
        const result = await rt.manager.getLogs({ runId, stageId });
        sendSuccess(respond, {
          logs: result.logs,
          stageId: result.stageId,
          totalLines: result.logs.length,
        });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod(
      "pipeline.pending",
      async ({ params: _params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const approvals = rt.manager.getPendingApprovals();
          sendSuccess(respond, {
            approvals: approvals.map((a) => ({
              id: a.id,
              runId: a.runId,
              stageId: a.stageId,
              stageName: a.stageName,
              pipelineName: a.pipelineName,
              createdAt: a.createdAt,
              expiresAt: a.expiresAt,
            })),
            count: approvals.length,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.history",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const pipelineId = typeof params?.pipeline === "string" ? params.pipeline.trim() : undefined;
          const limit = typeof params?.limit === "number" ? params.limit : 10;
          const result = await rt.manager.getHistory({ pipelineId, limit });
          sendSuccess(respond, {
            runs: result.runs.map((r) => ({
              id: r.id,
              providerRunId: r.providerRunId,
              state: r.state,
              result: r.result,
              pipelineId: r.pipelineId,
              pipelineName: r.pipelineName,
              sourceBranch: r.sourceBranch,
              queuedAt: r.queuedAt,
              finishedAt: r.finishedAt,
            })),
            totalCount: result.totalCount,
            hasMore: result.hasMore,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.list",
      async ({ params: _params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const pipelines = await rt.manager.listPipelines();
          sendSuccess(respond, {
            pipelines: pipelines.map((p) => ({
              id: p.id,
              name: p.name,
              path: p.path,
              defaultBranch: p.defaultBranch,
            })),
            count: pipelines.length,
          });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    api.registerGatewayMethod(
      "pipeline.cancel",
      async ({ params, respond }) => {
        try {
          const rt = await ensureRuntime();
          const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
          if (!runId) {
            respond(false, { error: "runId is required" });
            return;
          }
          await rt.manager.cancelPipeline(runId);
          sendSuccess(respond, { cancelled: true, runId });
        } catch (err) {
          sendError(respond, err);
        }
      }
    );

    // -------------------------------------------------------------------------
    // Tool Registration (for LLM access)
    // -------------------------------------------------------------------------

    api.registerTool({
      name: "pipeline",
      label: "Pipeline",
      description:
        "Manage CI/CD pipelines with multi-stage builds and approval gates. " +
        "Supports triggering pipelines, checking status, approving/rejecting stages, " +
        "fetching logs, viewing history, and listing available pipelines.",
      parameters: PipelineToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          const typedParams = params as Record<string, unknown>;
          const action = typedParams?.action;

          switch (action) {
            case "trigger": {
              const pipelineId = String(typedParams.pipeline || "").trim();
              if (!pipelineId) {
                return json({ error: "pipeline is required" });
              }
              const result = await rt.manager.triggerPipeline({
                pipelineId,
                branch: typeof typedParams.branch === "string" ? typedParams.branch.trim() : undefined,
                parameters: typedParams.parameters as Record<string, string> | undefined,
              });
              return json({
                success: true,
                message: `Pipeline "${result.run.pipelineName}" triggered successfully`,
                runId: result.runId,
                providerRunId: result.providerRunId,
                webUrl: result.webUrl,
                state: result.run.state,
                pipelineName: result.run.pipelineName,
                branch: result.run.sourceBranch,
                stages: result.run.stages.map((s) => ({
                  name: s.name,
                  state: s.state,
                  hasApprovalGate: s.hasApprovalGate,
                })),
              });
            }

            case "status": {
              const runId = String(typedParams.runId || "").trim();
              if (!runId) {
                return json({ error: "runId is required" });
              }
              const refresh = typedParams.refresh === true;
              const run = await rt.manager.getStatus({ runId, refresh });
              if (!run) {
                return json({
                  found: false,
                  message: `Pipeline run "${runId}" not found`,
                });
              }
              return json({
                found: true,
                id: run.id,
                providerRunId: run.providerRunId,
                state: run.state,
                result: run.result,
                pipelineId: run.pipelineId,
                pipelineName: run.pipelineName,
                sourceBranch: run.sourceBranch,
                webUrl: run.webUrl,
                triggeredBy: run.triggeredBy,
                queuedAt: run.queuedAt,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                durationMs: run.durationMs,
                stages: run.stages.map((s) => ({
                  id: s.id,
                  name: s.name,
                  displayName: s.displayName,
                  state: s.state,
                  result: s.result,
                  hasApprovalGate: s.hasApprovalGate,
                  startedAt: s.startedAt,
                  finishedAt: s.finishedAt,
                })),
              });
            }

            case "approve": {
              const approvalId = String(typedParams.approvalId || "").trim();
              if (!approvalId) {
                return json({ error: "approvalId is required" });
              }
              const result = await rt.manager.approve(approvalId, {
                comment: typeof typedParams.comment === "string" ? typedParams.comment : undefined,
              });
              return json({
                success: result.success,
                message: result.success
                  ? `Approval "${approvalId}" approved successfully`
                  : `Failed to approve: ${result.error}`,
                approvalId: result.approvalId,
                decision: result.decision,
                runId: result.runId,
                stageId: result.stageId,
              });
            }

            case "reject": {
              const approvalId = String(typedParams.approvalId || "").trim();
              if (!approvalId) {
                return json({ error: "approvalId is required" });
              }
              const result = await rt.manager.reject(approvalId, {
                comment: typeof typedParams.comment === "string" ? typedParams.comment : undefined,
              });
              return json({
                success: result.success,
                message: result.success
                  ? `Approval "${approvalId}" rejected`
                  : `Failed to reject: ${result.error}`,
                approvalId: result.approvalId,
                decision: result.decision,
                runId: result.runId,
                stageId: result.stageId,
              });
            }

            case "logs": {
              const runId = String(typedParams.runId || "").trim();
              if (!runId) {
                return json({ error: "runId is required" });
              }
              const stageId = typeof typedParams.stage === "string" ? typedParams.stage.trim() : undefined;
              const result = await rt.manager.getLogs({ runId, stageId });
              return json({
                runId,
                stageId: result.stageId,
                totalLines: result.logs.length,
                logs: result.logs.slice(0, 100), // Limit to first 100 lines
                truncated: result.logs.length > 100,
              });
            }

            case "history": {
              const pipelineId = typeof typedParams.pipeline === "string" ? typedParams.pipeline.trim() : undefined;
              const limit = typeof typedParams.limit === "number" ? Math.min(typedParams.limit, 50) : 10;
              const state = typeof typedParams.state === "string" ? typedParams.state as "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled" : undefined;
              const result = await rt.manager.getHistory({ pipelineId, limit, state });
              return json({
                runs: result.runs.map((r) => ({
                  id: r.id,
                  providerRunId: r.providerRunId,
                  state: r.state,
                  result: r.result,
                  pipelineId: r.pipelineId,
                  pipelineName: r.pipelineName,
                  sourceBranch: r.sourceBranch,
                  webUrl: r.webUrl,
                  queuedAt: r.queuedAt,
                  finishedAt: r.finishedAt,
                  durationMs: r.durationMs,
                })),
                totalCount: result.totalCount,
                hasMore: result.hasMore,
              });
            }

            case "list": {
              const pipelines = await rt.manager.listPipelines();
              return json({
                pipelines: pipelines.map((p) => ({
                  id: p.id,
                  name: p.name,
                  path: p.path,
                  defaultBranch: p.defaultBranch,
                  webUrl: p.webUrl,
                })),
                count: pipelines.length,
              });
            }

            case "pending": {
              const approvals = rt.manager.getPendingApprovals();
              if (approvals.length === 0) {
                return json({
                  message: "No pending approvals",
                  approvals: [],
                  count: 0,
                });
              }
              return json({
                message: `${approvals.length} pending approval(s)`,
                approvals: approvals.map((a) => ({
                  id: a.id,
                  runId: a.runId,
                  stageId: a.stageId,
                  stageName: a.stageName,
                  pipelineName: a.pipelineName,
                  createdAt: a.createdAt,
                  expiresAt: a.expiresAt,
                  approvers: a.approvers,
                  instructions: a.instructions,
                })),
                count: approvals.length,
              });
            }

            case "cancel": {
              const runId = String(typedParams.runId || "").trim();
              if (!runId) {
                return json({ error: "runId is required" });
              }
              await rt.manager.cancelPipeline(runId);
              return json({
                success: true,
                message: `Pipeline run "${runId}" cancelled`,
                runId,
              });
            }

            default:
              return json({
                error: `Unknown action: ${action}. Valid actions: trigger, status, approve, reject, logs, history, list, pending, cancel`,
              });
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // -------------------------------------------------------------------------
    // CLI Registration (placeholder - implementation in subtask 7.2)
    // -------------------------------------------------------------------------

    api.registerCli(
      ({ program: _program }) => {
        // CLI commands will be implemented in subtask 7.2
      },
      { commands: ["pipeline"] }
    );

    // -------------------------------------------------------------------------
    // Service Registration
    // -------------------------------------------------------------------------

    api.registerService({
      id: "pipeline",
      start: async () => {
        if (!cfg.enabled) return;
        try {
          await ensureRuntime();
          api.logger.info("[pipeline] Runtime started");
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
          const rt = await runtimePromise;
          await rt.dispose();
          api.logger.info("[pipeline] Runtime stopped");
        } catch (err) {
          api.logger.error(
            `[pipeline] Error during shutdown: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default pipelinePlugin;
