/**
 * Integration tests for PipelineManager
 *
 * End-to-end tests using mock provider to test full pipeline lifecycle,
 * approval workflow, notification dispatch, and error handling.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  PipelineManager,
  PipelineManagerError,
  createPipelineManager,
  createAndInitializePipelineManager,
} from "./manager.js";
import type {
  PipelineManagerDependencies,
  TriggerInput,
} from "./manager.js";
import { createStateMachine } from "./engine/state-machine.js";
import { createApprovalQueue } from "./engine/approval.js";
import { createApprovalHandler } from "./engine/approval-handler.js";
import { createNotificationHub } from "./notifications/hub.js";
import type { NotificationChannel, NotificationSendResult } from "./notifications/hub.js";
import { MockProvider } from "./providers/mock.js";
import type { PipelineRun, Notification } from "./types.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

/**
 * Creates a mock notification channel for testing
 */
function createMockNotificationChannel(
  type: "discord" | "slack" | "telegram" | "macos" = "discord"
): NotificationChannel & { sentNotifications: Notification[] } {
  return {
    type,
    name: `Mock ${type} Channel`,
    sentNotifications: [],
    isEnabled() {
      return true;
    },
    async send(notification: Notification): Promise<NotificationSendResult> {
      this.sentNotifications.push(notification);
      return { success: true, channel: type };
    },
  };
}

/**
 * Creates test dependencies for PipelineManager
 */
async function createTestDependencies(options?: {
  simulateApprovalGates?: boolean;
  stageCount?: number;
  simulatedDelayMs?: number;
  failureProbability?: number;
}): Promise<
  PipelineManagerDependencies & {
    mockChannel: NotificationChannel & { sentNotifications: Notification[] };
    mockProvider: MockProvider;
  }
> {
  // Create mock provider with configurable options
  const mockProvider = new MockProvider({
    stageCount: options?.stageCount ?? 3,
    simulateApprovalGates: options?.simulateApprovalGates ?? false,
    simulatedDelayMs: options?.simulatedDelayMs ?? 50,
    failureProbability: options?.failureProbability ?? 0,
  });
  await mockProvider.initialize();

  // Create state machine
  const stateMachine = createStateMachine();

  // Create notification hub with mock channel
  const notificationHub = createNotificationHub({
    includeStageNotifications: true,
  });
  await notificationHub.initialize();

  const mockChannel = createMockNotificationChannel();
  notificationHub.registerChannel("discord", mockChannel);

  // Create approval queue
  const approvalQueue = createApprovalQueue({
    defaultTimeoutMs: 60000,
    autoRejectOnTimeout: false,
  });
  approvalQueue.setNotificationHub(notificationHub);
  await approvalQueue.initialize();

  // Create approval handler
  const approvalHandler = createApprovalHandler({
    approvalQueue,
    stateMachine,
    getProvider: () => mockProvider,
  });
  await approvalHandler.initialize();

  return {
    provider: mockProvider,
    stateMachine,
    approvalQueue,
    approvalHandler,
    notificationHub,
    mockChannel,
    mockProvider,
  };
}

/**
 * Wait for a condition with timeout
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 50 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Wait for pipeline to reach a specific state
 */
async function waitForPipelineState(
  manager: PipelineManager,
  runId: string,
  states: string | string[],
  timeout = 5000
): Promise<PipelineRun | undefined> {
  const targetStates = Array.isArray(states) ? states : [states];
  await waitFor(
    async () => {
      const run = await manager.getStatus({ runId });
      return run !== undefined && targetStates.includes(run.state);
    },
    { timeout }
  );
  return manager.getStatus({ runId });
}

// -----------------------------------------------------------------------------
// Factory Function Tests
// -----------------------------------------------------------------------------

describe("PipelineManager", () => {
  describe("createPipelineManager factory", () => {
    it("creates a new manager instance", async () => {
      const deps = await createTestDependencies();
      const manager = createPipelineManager(deps);

      expect(manager).toBeInstanceOf(PipelineManager);
      expect(manager.isInitialized()).toBe(false);

      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("accepts configuration options", async () => {
      const deps = await createTestDependencies();
      const manager = createPipelineManager(deps, {
        polling: { enabled: false, intervalMs: 5000, fastIntervalMs: 1000, maxDurationMs: 60000 },
        defaultPipeline: "ci",
        defaultBranch: "main",
        autoStartPolling: false,
      });

      expect(manager).toBeInstanceOf(PipelineManager);

      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });
  });

  describe("createAndInitializePipelineManager factory", () => {
    it("creates and initializes manager", async () => {
      const deps = await createTestDependencies();
      const manager = await createAndInitializePipelineManager(deps);

      expect(manager).toBeInstanceOf(PipelineManager);
      expect(manager.isInitialized()).toBe(true);

      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Initialization Tests
  // ---------------------------------------------------------------------------

  describe("initialization", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies();
      manager = createPipelineManager(deps, { autoStartPolling: false });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("initialize() marks manager as initialized", async () => {
      expect(manager.isInitialized()).toBe(false);

      await manager.initialize();

      expect(manager.isInitialized()).toBe(true);
    });

    it("initialize() is idempotent", async () => {
      await manager.initialize();
      await manager.initialize();
      await manager.initialize();

      expect(manager.isInitialized()).toBe(true);
    });

    it("dispose() clears state and stops polling", async () => {
      await manager.initialize();

      await manager.dispose();

      expect(manager.isInitialized()).toBe(false);
    });

    it("throws NOT_INITIALIZED when calling methods before initialize", async () => {
      expect(() =>
        manager.triggerPipeline({ pipelineId: "ci" })
      ).rejects.toThrow(PipelineManagerError);

      expect(() =>
        manager.triggerPipeline({ pipelineId: "ci" })
      ).rejects.toThrow(/not initialized/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Full Pipeline Lifecycle Tests
  // ---------------------------------------------------------------------------

  describe("full pipeline lifecycle", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
        simulateApprovalGates: false,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
        polling: { enabled: false, intervalMs: 100, fastIntervalMs: 50, maxDurationMs: 10000 },
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("triggers a pipeline and tracks its execution", async () => {
      const input: TriggerInput = {
        pipelineId: "ci",
        branch: "main",
        triggeredBy: "test-user",
      };

      const result = await manager.triggerPipeline(input);

      expect(result.runId).toBeDefined();
      expect(result.providerRunId).toBeDefined();
      expect(result.run).toBeDefined();
      expect(result.run.state).toBe("queued");
      expect(result.run.pipelineName).toBe("Continuous Integration");
    });

    it("returns pipeline status after trigger", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      const status = await manager.getStatus({ runId: result.runId });

      expect(status).toBeDefined();
      expect(status?.id).toBe(result.runId);
      expect(status?.pipelineId).toBe("ci");
    });

    it("refreshes status from provider", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait a bit for mock provider to progress
      await new Promise((resolve) => setTimeout(resolve, 100));

      const refreshedStatus = await manager.getStatus({ runId: result.runId, refresh: true });

      expect(refreshedStatus).toBeDefined();
      // Status should be updated after refresh
      expect(["queued", "running", "succeeded"]).toContain(refreshedStatus?.state);
    });

    it("tracks pipeline through to completion", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      const finalRun = await waitForPipelineState(manager, result.runId, [
        "succeeded",
        "failed",
        "cancelled",
      ]);

      expect(finalRun).toBeDefined();
      expect(finalRun?.state).toBe("succeeded");
      expect(finalRun?.finishedAt).toBeDefined();
    });

    it("updates stage states as pipeline progresses", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      const finalRun = await manager.getStatus({ runId: result.runId, refresh: true });

      expect(finalRun?.stages).toHaveLength(2);
      expect(finalRun?.stages.every((s) => s.state === "succeeded")).toBe(true);
    });

    it("emits pipeline triggered event", async () => {
      const handler = vi.fn();
      manager.on("manager.pipeline_triggered", handler);

      await manager.triggerPipeline({ pipelineId: "ci" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          providerRunId: expect.any(String),
        })
      );
    });

    it("can cancel a running pipeline", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to start
      await waitForPipelineState(manager, result.runId, ["running"], 2000);

      await manager.cancelPipeline(result.runId);

      const status = await manager.getStatus({ runId: result.runId });
      expect(status?.state).toBe("cancelled");
    });

    it("throws NOT_FOUND for non-existent run", async () => {
      await expect(
        manager.getStatusOrThrow({ runId: "non-existent" })
      ).rejects.toThrow(PipelineManagerError);

      await expect(
        manager.getStatusOrThrow({ runId: "non-existent" })
      ).rejects.toThrow(/not found/i);
    });

    it("returns undefined for non-existent run with getStatus", async () => {
      const status = await manager.getStatus({ runId: "non-existent" });
      expect(status).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Approval Workflow Tests
  // ---------------------------------------------------------------------------

  describe("approval workflow", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 3,
        simulatedDelayMs: 50,
        simulateApprovalGates: true, // Enable approval gates
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
        polling: { enabled: false, intervalMs: 100, fastIntervalMs: 50, maxDurationMs: 10000 },
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("pauses pipeline at approval gate", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for pipeline to reach waiting_for_approval
      const run = await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      expect(run?.state).toBe("waiting_for_approval");
    });

    it("creates approval request when stage waits for approval", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for approval gate
      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const pendingApprovals = manager.getPendingApprovals();

      expect(pendingApprovals.length).toBeGreaterThanOrEqual(1);
      expect(pendingApprovals[0]?.runId).toBe(result.runId);
      expect(pendingApprovals[0]?.status).toBe("pending");
    });

    it("approves pending approval and continues pipeline", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for approval gate
      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const pendingApprovals = manager.getPendingApprovals();
      expect(pendingApprovals.length).toBeGreaterThanOrEqual(1);

      const approvalId = pendingApprovals[0]!.id;

      // Approve the stage
      const approvalResult = await manager.approve(approvalId, {
        comment: "LGTM",
        approvedBy: "test-approver",
      });

      expect(approvalResult.success).toBe(true);

      // Wait for pipeline to continue and complete
      const finalRun = await waitForPipelineState(manager, result.runId, [
        "succeeded",
        "running",
      ]);

      expect(["running", "succeeded"]).toContain(finalRun?.state);
    });

    it("rejects pending approval and fails pipeline", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for approval gate
      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const pendingApprovals = manager.getPendingApprovals();
      expect(pendingApprovals.length).toBeGreaterThanOrEqual(1);

      const approvalId = pendingApprovals[0]!.id;

      // Reject the stage
      const rejectResult = await manager.reject(approvalId, {
        comment: "Not ready for production",
        approvedBy: "test-approver",
      });

      expect(rejectResult.success).toBe(true);

      // Wait for pipeline to fail
      const finalRun = await waitForPipelineState(manager, result.runId, ["failed"]);

      expect(finalRun?.state).toBe("failed");
    });

    it("handleApproval processes approval decisions", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const pendingApprovals = manager.getPendingApprovals();
      const approvalId = pendingApprovals[0]!.id;

      const handleResult = await manager.handleApproval({
        approvalId,
        decision: "approve",
        comment: "Approved via handleApproval",
        approvedBy: "test-user",
      });

      expect(handleResult.success).toBe(true);
      expect(handleResult.decision).toBe("approve");
    });

    it("getApproval returns approval by ID", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const pendingApprovals = manager.getPendingApprovals();
      const approvalId = pendingApprovals[0]!.id;

      const approval = manager.getApproval(approvalId);

      expect(approval).toBeDefined();
      expect(approval?.id).toBe(approvalId);
      expect(approval?.status).toBe("pending");
    });

    it("getApproval returns undefined for non-existent ID", () => {
      const approval = manager.getApproval("non-existent");
      expect(approval).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Notification Dispatch Tests
  // ---------------------------------------------------------------------------

  describe("notification dispatch", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
        simulateApprovalGates: false,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
        polling: { enabled: false, intervalMs: 100, fastIntervalMs: 50, maxDurationMs: 10000 },
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("sends pipeline started notification", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to start
      await waitForPipelineState(manager, result.runId, ["running"]);

      // Wait a bit for notification to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      const notifications = deps.mockChannel.sentNotifications;
      const startedNotification = notifications.find(
        (n) => n.type === "pipeline_started" && n.runId === result.runId
      );

      expect(startedNotification).toBeDefined();
      expect(startedNotification?.title).toContain("Pipeline");
    });

    it("sends pipeline completed notification", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      // Wait a bit for notification to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      const notifications = deps.mockChannel.sentNotifications;
      const completedNotification = notifications.find(
        (n) => n.type === "pipeline_completed" && n.runId === result.runId
      );

      expect(completedNotification).toBeDefined();
    });

    it("sends stage notifications when configured", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      // Wait a bit for notifications to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      const notifications = deps.mockChannel.sentNotifications;
      const stageNotifications = notifications.filter(
        (n) =>
          (n.type === "stage_started" || n.type === "stage_completed") &&
          n.runId === result.runId
      );

      // Should have stage notifications for 2 stages (started + completed for each)
      expect(stageNotifications.length).toBeGreaterThan(0);
    });
  });

  describe("notification dispatch with approval", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 3,
        simulatedDelayMs: 50,
        simulateApprovalGates: true,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
        polling: { enabled: false, intervalMs: 100, fastIntervalMs: 50, maxDurationMs: 10000 },
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("sends approval required notification", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for approval gate
      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      // Wait a bit for notification to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      const notifications = deps.mockChannel.sentNotifications;
      const approvalNotification = notifications.find(
        (n) => n.type === "approval_required"
      );

      expect(approvalNotification).toBeDefined();
      expect(approvalNotification?.title).toContain("Approval");
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling Tests
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
        failureProbability: 0, // No random failures for these tests
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("throws VALIDATION_ERROR for empty pipeline ID", async () => {
      await expect(manager.triggerPipeline({ pipelineId: "" })).rejects.toThrow(
        PipelineManagerError
      );

      await expect(manager.triggerPipeline({ pipelineId: "" })).rejects.toThrow(
        /required/i
      );
    });

    it("throws PROVIDER_ERROR for non-existent pipeline", async () => {
      await expect(
        manager.triggerPipeline({ pipelineId: "non-existent-pipeline" })
      ).rejects.toThrow(PipelineManagerError);

      await expect(
        manager.triggerPipeline({ pipelineId: "non-existent-pipeline" })
      ).rejects.toThrow(/not found/i);
    });

    it("throws NOT_FOUND when getting logs for non-existent run", async () => {
      await expect(
        manager.getLogs({ runId: "non-existent" })
      ).rejects.toThrow(PipelineManagerError);

      await expect(manager.getLogs({ runId: "non-existent" })).rejects.toThrow(
        /not found/i
      );
    });

    it("emits error event on trigger failure", async () => {
      const handler = vi.fn();
      manager.on("manager.error", handler);

      await manager.triggerPipeline({ pipelineId: "non-existent" }).catch(() => {});

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          context: "triggerPipeline",
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Log Retrieval Tests
  // ---------------------------------------------------------------------------

  describe("log retrieval", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("retrieves logs for a pipeline run", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for some execution
      await waitForPipelineState(manager, result.runId, ["running", "succeeded"]);

      const logs = await manager.getLogs({ runId: result.runId });

      expect(logs.logs).toBeDefined();
      expect(Array.isArray(logs.logs)).toBe(true);
    });

    it("retrieves logs for a specific stage", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      const logs = await manager.getLogs({ runId: result.runId, stageId: "stage-0" });

      expect(logs.logs).toBeDefined();
      expect(logs.logs.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline Listing and History Tests
  // ---------------------------------------------------------------------------

  describe("pipeline listing and history", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 30,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("lists available pipelines", async () => {
      const pipelines = await manager.listPipelines();

      expect(Array.isArray(pipelines)).toBe(true);
      expect(pipelines.length).toBeGreaterThan(0);

      const pipelineIds = pipelines.map((p) => p.id);
      expect(pipelineIds).toContain("ci");
      expect(pipelineIds).toContain("build-and-deploy");
      expect(pipelineIds).toContain("release");
    });

    it("returns pipeline history", async () => {
      // Trigger a few pipelines
      const result1 = await manager.triggerPipeline({ pipelineId: "ci" });
      const result2 = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for completion
      await waitForPipelineState(manager, result1.runId, ["succeeded"]);
      await waitForPipelineState(manager, result2.runId, ["succeeded"]);

      const history = await manager.getHistory({ pipelineId: "ci" });

      expect(history.runs.length).toBeGreaterThanOrEqual(2);
      expect(history.totalCount).toBeGreaterThanOrEqual(2);
    });

    it("filters history by pipeline ID", async () => {
      await manager.triggerPipeline({ pipelineId: "ci" });
      await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      const history = await manager.getHistory({ pipelineId: "ci" });

      expect(history.runs.every((r) => r.pipelineId === "ci")).toBe(true);
    });

    it("filters history by state", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for completion
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      const succeededHistory = await manager.getHistory({ state: "succeeded" });

      expect(succeededHistory.runs.every((r) => r.state === "succeeded")).toBe(true);
    });

    it("limits history results", async () => {
      // Trigger multiple pipelines
      await manager.triggerPipeline({ pipelineId: "ci" });
      await manager.triggerPipeline({ pipelineId: "ci" });
      await manager.triggerPipeline({ pipelineId: "ci" });

      const history = await manager.getHistory({ limit: 2 });

      expect(history.runs.length).toBeLessThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Polling Tests
  // ---------------------------------------------------------------------------

  describe("polling", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
        polling: { enabled: true, intervalMs: 100, fastIntervalMs: 50, maxDurationMs: 5000 },
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("starts polling for a run", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      manager.startPolling(result.runId);

      expect(manager.isPolling(result.runId)).toBe(true);
    });

    it("stops polling for a run", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      manager.startPolling(result.runId);
      expect(manager.isPolling(result.runId)).toBe(true);

      manager.stopPolling(result.runId);
      expect(manager.isPolling(result.runId)).toBe(false);
    });

    it("emits polling events", async () => {
      const startedHandler = vi.fn();
      const stoppedHandler = vi.fn();
      manager.on("manager.polling_started", startedHandler);
      manager.on("manager.polling_stopped", stoppedHandler);

      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      manager.startPolling(result.runId);

      expect(startedHandler).toHaveBeenCalledWith({ runId: result.runId });

      manager.stopPolling(result.runId);

      expect(stoppedHandler).toHaveBeenCalledWith({
        runId: result.runId,
        reason: "cancelled",
      });
    });

    it("polling is idempotent (does not start twice)", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      manager.startPolling(result.runId);
      manager.startPolling(result.runId); // Should not error

      expect(manager.isPolling(result.runId)).toBe(true);
    });

    it("auto-stops polling when pipeline completes", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      manager.startPolling(result.runId);

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      // Give time for polling to stop
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(manager.isPolling(result.runId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Statistics Tests
  // ---------------------------------------------------------------------------

  describe("statistics", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("returns manager statistics", async () => {
      const stats = await manager.getStats();

      expect(stats).toBeDefined();
      expect(stats.initialized).toBe(true);
      expect(stats.provider).toBe("mock");
      expect(stats.activeRuns).toBe(0);
      expect(stats.pendingApprovals).toBe(0);
    });

    it("tracks active runs", async () => {
      const result = await manager.triggerPipeline({ pipelineId: "ci" });
      manager.startPolling(result.runId);

      const stats = await manager.getStats();

      expect(stats.activeRuns).toBe(1);
    });

    it("tracks pending approvals", async () => {
      // Use approval gates
      await deps.mockProvider.dispose();
      deps = await createTestDependencies({
        stageCount: 3,
        simulatedDelayMs: 50,
        simulateApprovalGates: true,
      });

      await manager.dispose();
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });

      const result = await manager.triggerPipeline({ pipelineId: "build-and-deploy" });

      // Wait for approval gate
      await waitForPipelineState(manager, result.runId, ["waiting_for_approval"]);

      const stats = await manager.getStats();

      expect(stats.pendingApprovals).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Event Handling Tests
  // ---------------------------------------------------------------------------

  describe("event handling", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies({
        stageCount: 2,
        simulatedDelayMs: 50,
      });
      manager = await createAndInitializePipelineManager(deps, {
        autoStartPolling: false,
      });
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("returns unsubscribe function from on()", async () => {
      const handler = vi.fn();

      const unsubscribe = manager.on("manager.pipeline_triggered", handler);
      await manager.triggerPipeline({ pipelineId: "ci" });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      await manager.triggerPipeline({ pipelineId: "ci" });
      expect(handler).toHaveBeenCalledTimes(1); // Not called again
    });

    it("off() removes handlers for specific event", async () => {
      const handler = vi.fn();
      manager.on("manager.pipeline_triggered", handler);

      manager.off("manager.pipeline_triggered");
      await manager.triggerPipeline({ pipelineId: "ci" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("off() without argument removes all handlers", async () => {
      const triggeredHandler = vi.fn();
      const errorHandler = vi.fn();
      manager.on("manager.pipeline_triggered", triggeredHandler);
      manager.on("manager.error", errorHandler);

      manager.off();
      await manager.triggerPipeline({ pipelineId: "ci" });

      expect(triggeredHandler).not.toHaveBeenCalled();
    });

    it("forwards state machine events", async () => {
      const startedHandler = vi.fn();
      const completedHandler = vi.fn();
      manager.on("pipeline.started", startedHandler);
      manager.on("pipeline.completed", completedHandler);

      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      expect(startedHandler).toHaveBeenCalled();
      expect(completedHandler).toHaveBeenCalled();
    });

    it("forwards stage events", async () => {
      const stageStartedHandler = vi.fn();
      const stageCompletedHandler = vi.fn();
      manager.on("stage.started", stageStartedHandler);
      manager.on("stage.completed", stageCompletedHandler);

      const result = await manager.triggerPipeline({ pipelineId: "ci" });

      // Wait for pipeline to complete
      await waitForPipelineState(manager, result.runId, ["succeeded"]);

      expect(stageStartedHandler).toHaveBeenCalled();
      expect(stageCompletedHandler).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Component Accessor Tests
  // ---------------------------------------------------------------------------

  describe("component accessors", () => {
    let deps: Awaited<ReturnType<typeof createTestDependencies>>;
    let manager: PipelineManager;

    beforeEach(async () => {
      deps = await createTestDependencies();
      manager = await createAndInitializePipelineManager(deps);
    });

    afterEach(async () => {
      await manager.dispose();
      await deps.mockProvider.dispose();
      await deps.notificationHub.dispose();
      await deps.approvalQueue.dispose();
      await deps.approvalHandler.dispose();
    });

    it("provides access to provider", () => {
      expect(manager.provider).toBeDefined();
      expect(manager.provider.name).toBe("mock");
    });

    it("provides access to state machine", () => {
      expect(manager.stateMachine).toBeDefined();
      expect(manager.stateMachine.runCount).toBe(0);
    });

    it("provides access to approval queue", () => {
      expect(manager.approvalQueue).toBeDefined();
      expect(manager.approvalQueue.approvalCount).toBe(0);
    });

    it("provides access to notification hub", () => {
      expect(manager.notificationHub).toBeDefined();
    });
  });
});

// -----------------------------------------------------------------------------
// PipelineManagerError Tests
// -----------------------------------------------------------------------------

describe("PipelineManagerError", () => {
  it("has correct error code and name", () => {
    const error = new PipelineManagerError("Test error", "NOT_FOUND");

    expect(error.name).toBe("PipelineManagerError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Test error");
  });

  it("supports all error codes", () => {
    const codes = [
      "NOT_INITIALIZED",
      "NOT_FOUND",
      "PROVIDER_ERROR",
      "STATE_ERROR",
      "APPROVAL_ERROR",
      "POLLING_ERROR",
      "VALIDATION_ERROR",
      "TIMEOUT",
    ] as const;

    for (const code of codes) {
      const error = new PipelineManagerError("Test", code);
      expect(error.code).toBe(code);
    }
  });
});
