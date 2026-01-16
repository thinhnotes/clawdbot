/**
 * Pipeline Integration Tests
 *
 * End-to-end tests for pipeline execution including:
 * - Full pipeline execution with mock Azure DevOps
 * - Approval notification delivery
 * - Command processing
 * - Pipeline persistence and reload
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineService } from "./service.js";
import type { PipelineServiceDeps, PipelineEvent, Logger } from "./state.js";
import type { ApprovalNotification } from "./approval-types.js";
import type { PipelineCreate, Pipeline, Stage, StageStatus } from "./types.js";
import { loadPipelineStore, savePipelineStore, deleteStore } from "./store.js";
import {
  dispatchPipelineCommand,
  handleApproveCommand,
  handleRejectCommand,
  handleStatusCommand,
  type PipelineCommandContext,
} from "./commands/index.js";
import { createPipelineServiceState } from "./state.js";
import { resolveNotificationChannels, notifyApprovalRequired } from "./approval-notify.js";

// ============================================================================
// Test Fixtures and Helpers
// ============================================================================

/**
 * Creates a mock logger that captures log calls
 */
function createMockLogger(): Logger & { calls: { level: string; obj: unknown; msg?: string }[] } {
  const calls: { level: string; obj: unknown; msg?: string }[] = [];
  return {
    calls,
    debug: (obj: unknown, msg?: string) => calls.push({ level: "debug", obj, msg }),
    info: (obj: unknown, msg?: string) => calls.push({ level: "info", obj, msg }),
    warn: (obj: unknown, msg?: string) => calls.push({ level: "warn", obj, msg }),
    error: (obj: unknown, msg?: string) => calls.push({ level: "error", obj, msg }),
  };
}

/**
 * Creates a temporary store path for testing
 */
function createTempStorePath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  return path.join(tmpDir, "pipelines.json");
}

/**
 * Cleans up temporary files
 */
async function cleanupTempStore(storePath: string): Promise<void> {
  try {
    await deleteStore(storePath);
    fs.rmdirSync(path.dirname(storePath));
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Creates a simple two-stage pipeline for testing
 */
function createTestPipeline(opts?: {
  requiresApproval?: boolean;
  notificationChannels?: string[];
}): PipelineCreate {
  return {
    name: "Test Pipeline",
    description: "A test pipeline for integration testing",
    stages: [
      {
        id: "build",
        name: "Build Stage",
        order: 1,
        dependencies: [],
        executor: { kind: "manual" },
        approvalConfig: {
          required: opts?.requiresApproval ?? false,
          approvers: ["user1", "user2"],
          timeoutMs: 3600000,
        },
      },
      {
        id: "deploy",
        name: "Deploy Stage",
        order: 2,
        dependencies: ["build"],
        executor: { kind: "manual" },
        approvalConfig: {
          required: true,
          approvers: ["admin"],
          timeoutMs: 7200000,
        },
      },
    ],
    config: {
      stopOnFailure: true,
      notificationChannels: opts?.notificationChannels ?? [],
    },
  };
}

/**
 * Creates a mock Azure DevOps stage pipeline
 */
function createAzdoPipeline(): PipelineCreate {
  return {
    name: "AzDO Pipeline",
    description: "Pipeline with Azure DevOps stages",
    stages: [
      {
        id: "build",
        name: "AzDO Build",
        order: 1,
        dependencies: [],
        executor: {
          kind: "azdo",
          organization: "https://dev.azure.com/testorg",
          project: "testproject",
          pipelineId: "123",
        },
        approvalConfig: { required: true },
      },
    ],
    config: {
      stopOnFailure: true,
      notificationChannels: ["discord:123456789"],
    },
  };
}

/**
 * Creates test dependencies with mocks
 */
function createTestDeps(opts?: {
  storePath?: string;
  nowMs?: () => number;
  onEvent?: (event: PipelineEvent) => void;
  sendNotification?: (notification: ApprovalNotification) => Promise<boolean>;
  executeStage?: (params: { pipeline: Pipeline; stageId: string }) => Promise<{
    status: "completed" | "failed" | "awaiting_approval";
    output?: string;
    error?: string;
    executorRunId?: string;
  }>;
}): PipelineServiceDeps & { mockLogger: ReturnType<typeof createMockLogger> } {
  const mockLogger = createMockLogger();
  return {
    mockLogger,
    log: mockLogger,
    storePath: opts?.storePath ?? createTempStorePath(),
    pipelineEnabled: true,
    nowMs: opts?.nowMs ?? (() => Date.now()),
    onEvent: opts?.onEvent,
    sendNotification: opts?.sendNotification,
    executeStage: opts?.executeStage,
  };
}

// ============================================================================
// Full Pipeline Execution Tests
// ============================================================================

describe("Full Pipeline Execution", () => {
  let service: PipelineService;
  let deps: ReturnType<typeof createTestDeps>;

  beforeEach(() => {
    deps = createTestDeps();
    service = new PipelineService(deps);
  });

  afterEach(async () => {
    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  it("executes a complete pipeline lifecycle: create -> start -> complete stages -> finish", async () => {
    await service.start();

    // Create pipeline
    const createResult = await service.create(createTestPipeline());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;
    expect(pipeline.status).toBe("pending");

    // Start pipeline
    const startResult = await service.start_(pipeline.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.startedStageId).toBe("build");

    // Get updated pipeline
    let currentPipeline = await service.get(pipeline.id);
    expect(currentPipeline?.status).toBe("running");
    expect(currentPipeline?.currentStageId).toBe("build");

    // Complete first stage
    const completeResult = await service.completeStage(pipeline.id, "build", {
      success: true,
      output: "Build completed successfully",
    });
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    expect(completeResult.data.shouldRequestApproval).toBe(false);

    // Advance to next stage
    const advanceResult = await service.advance(pipeline.id);
    expect(advanceResult.ok).toBe(true);
    if (!advanceResult.ok) return;
    expect(advanceResult.data.nextStageId).toBe("deploy");

    // Get updated pipeline - deploy stage requires approval
    currentPipeline = await service.get(pipeline.id);
    expect(currentPipeline?.currentStageId).toBe("deploy");

    // Complete deploy stage (approval required)
    const deployCompleteResult = await service.completeStage(pipeline.id, "deploy", {
      success: true,
      output: "Deploy ready for approval",
    });
    expect(deployCompleteResult.ok).toBe(true);
    if (!deployCompleteResult.ok) return;
    expect(deployCompleteResult.data.shouldRequestApproval).toBe(true);

    // Request approval
    const approvalRequest = await service.requestApproval(pipeline.id, "deploy", {
      requestedBy: "system",
    });
    expect(approvalRequest.ok).toBe(true);
    if (!approvalRequest.ok) return;
    expect(approvalRequest.data.status).toBe("pending");

    // Approve the stage
    const approveResult = await service.approve(pipeline.id, "deploy", {
      approvedBy: "admin",
      comment: "Approved for production",
    });
    expect(approveResult.ok).toBe(true);

    // Advance to complete pipeline
    const finalAdvance = await service.advance(pipeline.id);
    expect(finalAdvance.ok).toBe(true);
    if (!finalAdvance.ok) return;
    expect(finalAdvance.data.nextStageId).toBe(null);

    // Verify pipeline is completed
    currentPipeline = await service.get(pipeline.id);
    expect(currentPipeline?.status).toBe("completed");
  });

  it("handles pipeline failure with stopOnFailure", async () => {
    await service.start();

    const createResult = await service.create(createTestPipeline());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;

    // Start pipeline
    await service.start_(pipeline.id);

    // Fail the first stage
    const completeResult = await service.completeStage(pipeline.id, "build", {
      success: false,
      error: "Build failed: compilation error",
    });
    expect(completeResult.ok).toBe(true);

    // Pipeline should be failed due to stopOnFailure
    const currentPipeline = await service.get(pipeline.id);
    expect(currentPipeline?.status).toBe("failed");
  });

  it("handles stage rejection", async () => {
    await service.start();

    const createResult = await service.create(
      createTestPipeline({ requiresApproval: true })
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;

    // Start and prepare for approval
    await service.start_(pipeline.id);
    await service.completeStage(pipeline.id, "build", { success: true });

    // This stage requires approval, so we need to request it
    const buildStage = pipeline.stages.find(s => s.id === "build");
    if (buildStage?.approvalConfig.required) {
      await service.requestApproval(pipeline.id, "build", { requestedBy: "system" });
    }

    // Reject the stage
    const rejectResult = await service.reject(pipeline.id, "build", {
      rejectedBy: "security",
      comment: "Security review failed",
    });
    expect(rejectResult.ok).toBe(true);

    // Pipeline should be failed since stopOnFailure is true
    const currentPipeline = await service.get(pipeline.id);
    expect(currentPipeline?.status).toBe("failed");
  });

  it("tracks events throughout pipeline execution", async () => {
    const events: PipelineEvent[] = [];
    deps = createTestDeps({
      onEvent: (event) => events.push(event),
    });
    service = new PipelineService(deps);

    await service.start();

    // Create and start pipeline
    const createResult = await service.create(createTestPipeline());
    if (!createResult.ok) return;

    await service.start_(createResult.data.id);
    await service.completeStage(createResult.data.id, "build", { success: true });
    await service.advance(createResult.data.id);

    // Verify events were emitted
    const eventKinds = events.map((e) => e.kind);
    expect(eventKinds).toContain("pipeline_created");
    expect(eventKinds).toContain("pipeline_started");
    expect(eventKinds).toContain("stage_started");
    expect(eventKinds).toContain("stage_completed");
  });
});

// ============================================================================
// Mock Azure DevOps Execution Tests
// ============================================================================

describe("Pipeline Execution with Mock Azure DevOps", () => {
  let service: PipelineService;
  let deps: ReturnType<typeof createTestDeps>;
  let executeStageResults: {
    status: "completed" | "failed" | "awaiting_approval";
    output?: string;
    error?: string;
    executorRunId?: string;
  }[];

  beforeEach(() => {
    executeStageResults = [];
    deps = createTestDeps({
      executeStage: async ({ pipeline, stageId }) => {
        // Pop the next result or default to completed
        const result = executeStageResults.shift() ?? {
          status: "completed" as const,
          output: `Stage ${stageId} completed successfully`,
          executorRunId: "12345",
        };
        return result;
      },
    });
    service = new PipelineService(deps);
  });

  afterEach(async () => {
    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  it("executes Azure DevOps stage with mocked executor", async () => {
    await service.start();

    executeStageResults.push({
      status: "completed",
      output: "Azure DevOps build 12345 succeeded",
      executorRunId: "12345",
    });

    const createResult = await service.create(createAzdoPipeline());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;

    // Start pipeline
    const startResult = await service.start_(pipeline.id);
    expect(startResult.ok).toBe(true);

    // Verify the AzDO stage is set up correctly
    const currentPipeline = await service.get(pipeline.id);
    const buildStage = currentPipeline?.stages.find((s) => s.id === "build");
    expect(buildStage?.executor.kind).toBe("azdo");
  });

  it("handles Azure DevOps build failure", async () => {
    await service.start();

    executeStageResults.push({
      status: "failed",
      error: "Azure DevOps build failed with result: failed",
      executorRunId: "12346",
    });

    const createResult = await service.create(createAzdoPipeline());
    if (!createResult.ok) return;

    await service.start_(createResult.data.id);

    // Simulate stage failure
    const completeResult = await service.completeStage(
      createResult.data.id,
      "build",
      {
        success: false,
        error: "Build failed",
      }
    );
    expect(completeResult.ok).toBe(true);

    const currentPipeline = await service.get(createResult.data.id);
    expect(currentPipeline?.status).toBe("failed");
  });

  it("handles Azure DevOps awaiting_approval status", async () => {
    await service.start();

    executeStageResults.push({
      status: "awaiting_approval",
      output: "Azure DevOps build succeeded. Awaiting approval.",
      executorRunId: "12347",
    });

    const createResult = await service.create(createAzdoPipeline());
    if (!createResult.ok) return;

    await service.start_(createResult.data.id);

    // Complete with need for approval
    const completeResult = await service.completeStage(
      createResult.data.id,
      "build",
      { success: true }
    );
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;

    // Stage requires approval
    expect(completeResult.data.shouldRequestApproval).toBe(true);
  });
});

// ============================================================================
// Approval Notification Tests
// ============================================================================

describe("Approval Notification Delivery", () => {
  let service: PipelineService;
  let deps: ReturnType<typeof createTestDeps>;
  let sentNotifications: ApprovalNotification[];

  beforeEach(() => {
    sentNotifications = [];
    deps = createTestDeps({
      sendNotification: async (notification) => {
        sentNotifications.push(notification);
        return true;
      },
    });
    service = new PipelineService(deps);
  });

  afterEach(async () => {
    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  it("sends approval required notification to configured channels", async () => {
    await service.start();

    const createResult = await service.create(
      createTestPipeline({
        requiresApproval: true,
        notificationChannels: ["discord:123456789", "slack:channel-id"],
      })
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;

    // Start pipeline and request approval
    await service.start_(pipeline.id);
    await service.completeStage(pipeline.id, "build", { success: true });

    // Need to use the notify function directly since service doesn't auto-notify
    const state = createPipelineServiceState({
      ...deps,
      sendNotification: async (notification) => {
        sentNotifications.push(notification);
        return true;
      },
    });

    // Load store into state
    state.store = await loadPipelineStore(deps.storePath);

    await notifyApprovalRequired(state, {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      stageId: "build",
      stageName: "Build Stage",
      requestedBy: "system",
      expiresInMs: 3600000,
    });

    // Verify notifications were sent to both channels
    expect(sentNotifications.length).toBeGreaterThanOrEqual(2);
    expect(sentNotifications.some((n) => n.channel === "discord")).toBe(true);
    expect(sentNotifications.some((n) => n.channel === "slack")).toBe(true);
  });

  it("resolves notification channels from config strings", () => {
    const channels = resolveNotificationChannels([
      "discord:123456789",
      "slack:C12345678",
      "telegram:987654321",
      "push:user123",
    ]);

    expect(channels).toHaveLength(4);
    expect(channels[0]).toEqual({
      channel: "discord",
      recipient: "123456789",
      enabled: true,
    });
    expect(channels[1]).toEqual({
      channel: "slack",
      recipient: "C12345678",
      enabled: true,
    });
    expect(channels[2]).toEqual({
      channel: "telegram",
      recipient: "987654321",
      enabled: true,
    });
    expect(channels[3]).toEqual({
      channel: "push",
      recipient: "user123",
      enabled: true,
    });
  });

  it("ignores invalid channel formats", () => {
    const channels = resolveNotificationChannels([
      "discord:123456789", // valid
      "invalid", // no colon
      "unknown:channel", // unknown channel type
      ":empty", // empty channel
      "slack:", // empty recipient
    ]);

    expect(channels).toHaveLength(1);
    expect(channels[0].channel).toBe("discord");
  });

  it("handles empty notification channels gracefully", async () => {
    await service.start();

    const createResult = await service.create(
      createTestPipeline({
        requiresApproval: true,
        notificationChannels: [],
      })
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipeline = createResult.data;

    // Start pipeline
    await service.start_(pipeline.id);

    // No notifications should be sent
    expect(sentNotifications).toHaveLength(0);
  });
});

// ============================================================================
// Command Processing Tests
// ============================================================================

describe("Pipeline Command Processing", () => {
  let service: PipelineService;
  let deps: ReturnType<typeof createTestDeps>;
  let state: ReturnType<typeof createPipelineServiceState>;

  beforeEach(async () => {
    deps = createTestDeps();
    service = new PipelineService(deps);
    await service.start();

    // Create state for command testing
    state = createPipelineServiceState(deps);
    state.store = await loadPipelineStore(deps.storePath);
  });

  afterEach(async () => {
    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  describe("approve command", () => {
    it("approves a stage awaiting approval", async () => {
      // Create pipeline with approval required
      const createResult = await service.create(
        createTestPipeline({ requiresApproval: true })
      );
      if (!createResult.ok) return;

      const pipeline = createResult.data;

      // Get to approval state
      await service.start_(pipeline.id);
      await service.completeStage(pipeline.id, "build", { success: true });
      await service.requestApproval(pipeline.id, "build", { requestedBy: "system" });

      // Reload state
      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
        approverList: ["user1", "user2"],
      };

      const result = await handleApproveCommand(
        state,
        `${pipeline.id} build`,
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("approved");
    });

    it("rejects approval from unauthorized user", async () => {
      const createResult = await service.create(
        createTestPipeline({ requiresApproval: true })
      );
      if (!createResult.ok) return;

      const pipeline = createResult.data;

      await service.start_(pipeline.id);
      await service.completeStage(pipeline.id, "build", { success: true });
      await service.requestApproval(pipeline.id, "build", { requestedBy: "system" });

      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "unauthorized-user",
        isAuthorized: false,
        approverList: ["user1", "user2"],
      };

      const result = await handleApproveCommand(
        state,
        `${pipeline.id} build`,
        context
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("permission");
    });

    it("handles invalid pipeline ID", async () => {
      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
      };

      const result = await handleApproveCommand(
        state,
        "nonexistent-pipeline build",
        context
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });

  describe("reject command", () => {
    it("rejects a stage awaiting approval", async () => {
      const createResult = await service.create(
        createTestPipeline({ requiresApproval: true })
      );
      if (!createResult.ok) return;

      const pipeline = createResult.data;

      await service.start_(pipeline.id);
      await service.completeStage(pipeline.id, "build", { success: true });
      await service.requestApproval(pipeline.id, "build", { requestedBy: "system" });

      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
        approverList: ["user1", "user2"],
      };

      const result = await handleRejectCommand(
        state,
        `${pipeline.id} build "Security issue found"`,
        context
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("rejected");
    });
  });

  describe("status command", () => {
    it("lists all pipelines", async () => {
      const createResult1 = await service.create(createTestPipeline());
      const createResult2 = await service.create({
        ...createTestPipeline(),
        name: "Second Pipeline",
      });

      expect(createResult1.ok).toBe(true);
      expect(createResult2.ok).toBe(true);

      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
      };

      const result = await handleStatusCommand(state, "", context);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Test Pipeline");
      expect(result.message).toContain("Second Pipeline");
    });

    it("shows detailed status for specific pipeline", async () => {
      const createResult = await service.create(createTestPipeline());
      if (!createResult.ok) return;

      const pipeline = createResult.data;
      await service.start_(pipeline.id);

      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
      };

      const result = await handleStatusCommand(state, pipeline.id, context);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Test Pipeline");
      expect(result.message).toContain("Build Stage");
      expect(result.message).toContain("Deploy Stage");
    });
  });

  describe("dispatchPipelineCommand", () => {
    it("routes to approve command", async () => {
      const createResult = await service.create(
        createTestPipeline({ requiresApproval: true })
      );
      if (!createResult.ok) return;

      const pipeline = createResult.data;

      await service.start_(pipeline.id);
      await service.completeStage(pipeline.id, "build", { success: true });
      await service.requestApproval(pipeline.id, "build", { requestedBy: "system" });

      state.store = await loadPipelineStore(deps.storePath);

      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
        approverList: ["user1"],
      };

      const result = await dispatchPipelineCommand(
        state,
        "approve",
        `${pipeline.id} build`,
        context
      );

      expect(result.success).toBe(true);
    });

    it("returns error for unknown command", async () => {
      const context: PipelineCommandContext = {
        userId: "user1",
        isAuthorized: true,
      };

      const result = await dispatchPipelineCommand(
        state,
        "unknown-command",
        "",
        context
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unknown pipeline command");
    });
  });
});

// ============================================================================
// Pipeline Persistence Tests
// ============================================================================

describe("Pipeline Persistence and Reload", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = createTempStorePath();
  });

  afterEach(async () => {
    await cleanupTempStore(storePath);
  });

  it("persists pipelines to disk and reloads them", async () => {
    const deps = createTestDeps({ storePath });
    let service = new PipelineService(deps);

    await service.start();

    // Create a pipeline
    const createResult = await service.create(createTestPipeline());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const pipelineId = createResult.data.id;

    // Start and modify the pipeline
    await service.start_(pipelineId);

    // Stop service
    service.stop();

    // Verify file exists
    const store = await loadPipelineStore(storePath);
    expect(store.pipelines.length).toBe(1);
    expect(store.pipelines[0].id).toBe(pipelineId);
    expect(store.pipelines[0].status).toBe("running");

    // Create new service and reload
    service = new PipelineService(deps);
    await service.start();

    // Verify pipeline was reloaded
    const reloadedPipeline = await service.get(pipelineId);
    expect(reloadedPipeline).not.toBeNull();
    expect(reloadedPipeline?.id).toBe(pipelineId);
    expect(reloadedPipeline?.status).toBe("running");
    expect(reloadedPipeline?.name).toBe("Test Pipeline");

    service.stop();
  });

  it("persists approval requests and reloads them", async () => {
    const deps = createTestDeps({ storePath });
    let service = new PipelineService(deps);

    await service.start();

    // Create pipeline with approval required
    const createResult = await service.create(
      createTestPipeline({ requiresApproval: true })
    );
    if (!createResult.ok) return;

    const pipelineId = createResult.data.id;

    // Get to approval state
    await service.start_(pipelineId);
    await service.completeStage(pipelineId, "build", { success: true });
    const approvalResult = await service.requestApproval(pipelineId, "build", {
      requestedBy: "user1",
    });
    expect(approvalResult.ok).toBe(true);

    service.stop();

    // Verify approval request persisted
    const store = await loadPipelineStore(storePath);
    expect(store.approvalRequests.length).toBe(1);
    expect(store.approvalRequests[0].pipelineId).toBe(pipelineId);
    expect(store.approvalRequests[0].stageId).toBe("build");
    expect(store.approvalRequests[0].status).toBe("pending");

    // Reload and verify
    service = new PipelineService(deps);
    await service.start();

    const pendingApprovals = await service.getPendingApprovals();
    expect(pendingApprovals.length).toBe(1);
    expect(pendingApprovals[0].pipelineId).toBe(pipelineId);

    service.stop();
  });

  it("handles empty store file gracefully", async () => {
    // Start with no store file
    const deps = createTestDeps({ storePath });
    const service = new PipelineService(deps);

    await service.start();

    // Should work with empty store
    const pipelines = await service.list();
    expect(pipelines).toEqual([]);

    const status = await service.status();
    expect(status.pipelineCount).toBe(0);

    service.stop();
  });

  it("handles corrupted store file gracefully", async () => {
    // Write corrupted data
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(storePath, "not valid json {{{");

    const deps = createTestDeps({ storePath });
    const service = new PipelineService(deps);

    // Should not throw
    await service.start();

    // Should work with empty store (fallback)
    const pipelines = await service.list();
    expect(pipelines).toEqual([]);

    service.stop();
  });

  it("creates backup file on save", async () => {
    const deps = createTestDeps({ storePath });
    const service = new PipelineService(deps);

    await service.start();

    // Create a pipeline (triggers save)
    const createResult = await service.create(createTestPipeline());
    expect(createResult.ok).toBe(true);

    service.stop();

    // Verify backup file exists
    const backupPath = `${storePath}.bak`;
    const backupExists = fs.existsSync(backupPath);
    expect(backupExists).toBe(true);
  });

  it("persists stage state changes", async () => {
    const deps = createTestDeps({ storePath });
    let service = new PipelineService(deps);

    await service.start();

    const createResult = await service.create(createTestPipeline());
    if (!createResult.ok) return;

    const pipelineId = createResult.data.id;

    await service.start_(pipelineId);
    await service.completeStage(pipelineId, "build", {
      success: true,
      output: "Build output here",
    });
    await service.advance(pipelineId);

    service.stop();

    // Reload and verify stage states
    const store = await loadPipelineStore(storePath);
    const pipeline = store.pipelines[0];

    const buildStage = pipeline.stages.find((s) => s.id === "build");
    expect(buildStage?.status).toBe("completed");
    expect(buildStage?.state.completedAtMs).toBeDefined();
    expect(buildStage?.state.output).toBe("Build output here");

    const deployStage = pipeline.stages.find((s) => s.id === "deploy");
    expect(deployStage?.status).toBe("running");
    expect(deployStage?.state.startedAtMs).toBeDefined();
  });
});

// ============================================================================
// Concurrent Operations Tests
// ============================================================================

describe("Concurrent Operations", () => {
  let service: PipelineService;
  let deps: ReturnType<typeof createTestDeps>;

  beforeEach(() => {
    deps = createTestDeps();
    service = new PipelineService(deps);
  });

  afterEach(async () => {
    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  it("handles concurrent pipeline creation", async () => {
    await service.start();

    // Create multiple pipelines concurrently
    const createPromises = Array.from({ length: 5 }, (_, i) =>
      service.create({
        ...createTestPipeline(),
        name: `Pipeline ${i}`,
      })
    );

    const results = await Promise.all(createPromises);

    // All should succeed
    expect(results.every((r) => r.ok)).toBe(true);

    // All should have unique IDs
    const ids = results.map((r) => (r.ok ? r.data.id : ""));
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);

    // All should be listed
    const pipelines = await service.list({ includeCompleted: true });
    expect(pipelines.length).toBe(5);
  });

  it("handles concurrent operations on same pipeline", async () => {
    await service.start();

    const createResult = await service.create(createTestPipeline());
    if (!createResult.ok) return;

    const pipelineId = createResult.data.id;

    // Start pipeline first
    await service.start_(pipelineId);

    // Perform multiple concurrent operations
    const operations = [
      service.get(pipelineId),
      service.status(),
      service.list(),
      service.getPendingApprovals(),
    ];

    const results = await Promise.all(operations);

    // All should complete without error
    expect(results[0]).not.toBeNull(); // get
    expect((results[1] as { pipelineCount: number }).pipelineCount).toBe(1); // status
    expect((results[2] as Pipeline[]).length).toBe(1); // list
    expect((results[3] as unknown[]).length).toBe(0); // pending approvals
  });

  it("serializes state-modifying operations correctly", async () => {
    await service.start();

    const createResult = await service.create(
      createTestPipeline({ requiresApproval: true })
    );
    if (!createResult.ok) return;

    const pipelineId = createResult.data.id;

    // Start pipeline
    await service.start_(pipelineId);
    await service.completeStage(pipelineId, "build", { success: true });
    await service.requestApproval(pipelineId, "build", { requestedBy: "system" });

    // Try to approve and reject concurrently - only one should succeed
    const [approveResult, rejectResult] = await Promise.all([
      service.approve(pipelineId, "build", { approvedBy: "user1" }),
      service.reject(pipelineId, "build", { rejectedBy: "user2" }),
    ]);

    // One should succeed, one should fail
    const successCount = [approveResult.ok, rejectResult.ok].filter(Boolean).length;
    expect(successCount).toBe(1);

    // Final state should be consistent
    const pipeline = await service.get(pipelineId);
    const buildStage = pipeline?.stages.find((s) => s.id === "build");
    expect(["approved", "rejected"]).toContain(buildStage?.status);
  });
});

// ============================================================================
// Service Lifecycle Tests
// ============================================================================

describe("Service Lifecycle", () => {
  it("starts and stops cleanly", async () => {
    const deps = createTestDeps();
    const service = new PipelineService(deps);

    // Start
    await service.start();
    const status1 = await service.status();
    expect(status1.enabled).toBe(true);

    // Stop
    service.stop();

    await cleanupTempStore(deps.storePath);
  });

  it("handles multiple start/stop cycles", async () => {
    const deps = createTestDeps();
    const service = new PipelineService(deps);

    for (let i = 0; i < 3; i++) {
      await service.start();
      const status = await service.status();
      expect(status.enabled).toBe(true);
      service.stop();
    }

    await cleanupTempStore(deps.storePath);
  });

  it("reports correct status when disabled", async () => {
    const deps = createTestDeps();
    (deps as { pipelineEnabled: boolean }).pipelineEnabled = false;
    const service = new PipelineService(deps);

    await service.start();
    const status = await service.status();
    expect(status.enabled).toBe(false);

    service.stop();
    await cleanupTempStore(deps.storePath);
  });

  it("logs warning when operations attempted on disabled service", async () => {
    const deps = createTestDeps();
    (deps as { pipelineEnabled: boolean }).pipelineEnabled = false;
    const service = new PipelineService(deps);

    await service.start();

    // Attempt to create pipeline
    await service.create(createTestPipeline());

    // Should have warned
    const warns = deps.mockLogger.calls.filter((c) => c.level === "warn");
    expect(warns.length).toBeGreaterThan(0);

    service.stop();
    await cleanupTempStore(deps.storePath);
  });
});
