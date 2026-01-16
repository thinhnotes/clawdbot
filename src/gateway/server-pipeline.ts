import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { PipelineService, type PipelineEvent } from "../pipeline/service.js";
import { resolvePipelineStorePath } from "../pipeline/store.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type GatewayPipelineState = {
  pipeline: PipelineService;
  storePath: string;
  pipelineEnabled: boolean;
};

export function buildGatewayPipelineService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayPipelineState {
  const pipelineLogger = getChildLogger({ module: "pipeline" });
  const storePath = resolvePipelineStorePath(params.cfg.pipeline?.store);
  const pipelineEnabled =
    process.env.CLAWDBOT_SKIP_PIPELINE !== "1" && params.cfg.pipeline?.enabled !== false;

  const resolvePipelineAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const pipeline = new PipelineService({
    storePath,
    pipelineEnabled,
    log: getChildLogger({ module: "pipeline", storePath }),
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolvePipelineAgent(opts?.agentId);
      const sessionKey = resolveAgentMainSessionKey({
        cfg: runtimeConfig,
        agentId,
      });
      enqueueSystemEvent(text, { sessionKey });
    },
    onEvent: (evt: PipelineEvent) => {
      params.broadcast("pipeline", evt, { dropIfSlow: true });
      // Log key events for visibility
      if (evt.kind === "pipeline_started") {
        pipelineLogger.info(
          { pipelineId: evt.pipelineId, name: evt.name },
          "pipeline: started",
        );
      } else if (evt.kind === "pipeline_completed") {
        pipelineLogger.info(
          { pipelineId: evt.pipelineId, name: evt.name, success: evt.success },
          "pipeline: completed",
        );
      } else if (evt.kind === "approval_event") {
        pipelineLogger.info(
          { pipelineId: evt.event.pipelineId, stageId: evt.event.stageId, type: evt.event.type },
          "pipeline: approval event",
        );
      }
    },
  });

  return { pipeline, storePath, pipelineEnabled };
}
