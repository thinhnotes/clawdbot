/**
 * Unit tests for ApprovalQueue
 *
 * Tests approval add/remove, timeout handling, and decision processing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  ApprovalQueue,
  ApprovalQueueError,
  createApprovalQueue,
  createAndInitializeApprovalQueue,
} from "./approval.js";
import type {
  CreateApprovalInput,
  ApprovalNotificationHub,
} from "./approval.js";
import type { ApprovalRequest, ApprovalResponse } from "../types.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

function createTestApprovalInput(
  overrides: Partial<CreateApprovalInput> = {}
): CreateApprovalInput {
  return {
    runId: `run-${Date.now()}`,
    stageId: "stage-1",
    stageName: "Deploy to Production",
    pipelineName: "Release Pipeline",
    ...overrides,
  };
}

function createMockNotificationHub(): ApprovalNotificationHub & {
  notifyApprovalRequiredCalls: ApprovalRequest[];
  notifyApprovalCompletedCalls: { approval: ApprovalRequest; response: ApprovalResponse }[];
  notifyApprovalTimeoutCalls: ApprovalRequest[];
} {
  return {
    notifyApprovalRequiredCalls: [],
    notifyApprovalCompletedCalls: [],
    notifyApprovalTimeoutCalls: [],
    async notifyApprovalRequired(approval: ApprovalRequest) {
      this.notifyApprovalRequiredCalls.push(approval);
    },
    async notifyApprovalCompleted(approval: ApprovalRequest, response: ApprovalResponse) {
      this.notifyApprovalCompletedCalls.push({ approval, response });
    },
    async notifyApprovalTimeout(approval: ApprovalRequest) {
      this.notifyApprovalTimeoutCalls.push(approval);
    },
  };
}

// -----------------------------------------------------------------------------
// Factory Function Tests
// -----------------------------------------------------------------------------

describe("ApprovalQueue", () => {
  describe("createApprovalQueue factory", () => {
    it("creates a new queue instance", () => {
      const queue = createApprovalQueue();
      expect(queue).toBeInstanceOf(ApprovalQueue);
      expect(queue.isInitialized()).toBe(false);
    });

    it("accepts configuration options", () => {
      const queue = createApprovalQueue({
        defaultTimeoutMs: 60000,
        requireRejectComment: true,
        autoRejectOnTimeout: true,
        authorizedApprovers: ["admin@example.com"],
      });
      expect(queue).toBeInstanceOf(ApprovalQueue);
    });
  });

  describe("createAndInitializeApprovalQueue factory", () => {
    it("creates and initializes queue", async () => {
      const queue = await createAndInitializeApprovalQueue();
      expect(queue).toBeInstanceOf(ApprovalQueue);
      expect(queue.isInitialized()).toBe(true);
      await queue.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Initialization Tests
  // ---------------------------------------------------------------------------

  describe("initialization", () => {
    it("initialize() marks queue as initialized", async () => {
      const queue = createApprovalQueue();
      expect(queue.isInitialized()).toBe(false);

      await queue.initialize();

      expect(queue.isInitialized()).toBe(true);
      await queue.dispose();
    });

    it("initialize() is idempotent", async () => {
      const queue = createApprovalQueue();

      await queue.initialize();
      await queue.initialize();
      await queue.initialize();

      expect(queue.isInitialized()).toBe(true);
      await queue.dispose();
    });

    it("dispose() clears state and marks as not initialized", async () => {
      const queue = await createAndInitializeApprovalQueue();
      await queue.addApproval(createTestApprovalInput());

      await queue.dispose();

      expect(queue.isInitialized()).toBe(false);
      expect(queue.approvalCount).toBe(0);
    });

    it("setNotificationHub() configures notification hub", async () => {
      const queue = await createAndInitializeApprovalQueue();
      const hub = createMockNotificationHub();

      queue.setNotificationHub(hub);
      await queue.addApproval(createTestApprovalInput());

      expect(hub.notifyApprovalRequiredCalls).toHaveLength(1);
      await queue.dispose();
    });

    it("throws NOT_INITIALIZED error when not initialized", () => {
      const queue = createApprovalQueue();

      expect(() => queue.getApproval("test")).toThrow(ApprovalQueueError);
      expect(() => queue.getApproval("test")).toThrow(/not initialized/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Add Approval Tests
  // ---------------------------------------------------------------------------

  describe("addApproval", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("creates a new approval with pending status", async () => {
      const input = createTestApprovalInput({ runId: "run-1", stageId: "stage-1" });

      const approval = await queue.addApproval(input);

      expect(approval.id).toBeDefined();
      expect(approval.runId).toBe("run-1");
      expect(approval.stageId).toBe("stage-1");
      expect(approval.stageName).toBe("Deploy to Production");
      expect(approval.pipelineName).toBe("Release Pipeline");
      expect(approval.status).toBe("pending");
      expect(approval.requestedAt).toBeDefined();
      expect(approval.expiresAt).toBeGreaterThan(approval.requestedAt);
    });

    it("generates unique IDs for each approval", async () => {
      const approval1 = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      const approval2 = await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));

      expect(approval1.id).not.toBe(approval2.id);
    });

    it("uses custom timeout when provided", async () => {
      const customTimeout = 5000;
      const input = createTestApprovalInput({ timeoutMs: customTimeout });

      const approval = await queue.addApproval(input);

      expect(approval.expiresAt! - approval.requestedAt).toBe(customTimeout);
    });

    it("includes optional fields when provided", async () => {
      const input = createTestApprovalInput({
        providerRunId: "provider-run-123",
        providerApprovalId: "provider-approval-456",
        approvers: ["user@example.com", "admin@example.com"],
        instructions: "Please review the deployment",
        metadata: { environment: "production" },
      });

      const approval = await queue.addApproval(input);

      expect(approval.providerRunId).toBe("provider-run-123");
      expect(approval.providerApprovalId).toBe("provider-approval-456");
      expect(approval.approvers).toEqual(["user@example.com", "admin@example.com"]);
      expect(approval.instructions).toBe("Please review the deployment");
      expect(approval.metadata).toEqual({ environment: "production" });
    });

    it("emits approval.added event", async () => {
      const handler = vi.fn();
      queue.on("approval.added", handler);

      const approval = await queue.addApproval(createTestApprovalInput());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: approval.id }));
    });

    it("sends notification when hub is configured", async () => {
      const hub = createMockNotificationHub();
      queue.setNotificationHub(hub);

      await queue.addApproval(createTestApprovalInput());

      expect(hub.notifyApprovalRequiredCalls).toHaveLength(1);
    });

    it("throws ALREADY_EXISTS for duplicate run/stage combination", async () => {
      const input = createTestApprovalInput({ runId: "run-1", stageId: "stage-1" });

      await queue.addApproval(input);

      await expect(queue.addApproval(input)).rejects.toThrow(ApprovalQueueError);
      await expect(queue.addApproval(input)).rejects.toThrow(/already pending/i);
    });

    it("allows new approval for same run/stage after completion", async () => {
      const input = createTestApprovalInput({ runId: "run-1", stageId: "stage-1" });

      const first = await queue.addApproval(input);
      await queue.completeApproval(first.id, "approved");

      const second = await queue.addApproval(input);

      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
    });

    it("increments approvalCount", async () => {
      expect(queue.approvalCount).toBe(0);

      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      expect(queue.approvalCount).toBe(1);

      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      expect(queue.approvalCount).toBe(2);
    });

    it("uses config authorizedApprovers when input approvers not provided", async () => {
      const queueWithApprovers = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["default@example.com"],
      });
      const input = createTestApprovalInput();

      const approval = await queueWithApprovers.addApproval(input);

      expect(approval.approvers).toEqual(["default@example.com"]);
      await queueWithApprovers.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Get Approval Tests
  // ---------------------------------------------------------------------------

  describe("getApproval", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns approval by ID", async () => {
      const created = await queue.addApproval(createTestApprovalInput());

      const retrieved = queue.getApproval(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it("returns undefined for non-existent ID", () => {
      const result = queue.getApproval("non-existent");
      expect(result).toBeUndefined();
    });
  });

  describe("getApprovalOrThrow", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns approval when found", async () => {
      const created = await queue.addApproval(createTestApprovalInput());

      const retrieved = queue.getApprovalOrThrow(created.id);

      expect(retrieved.id).toBe(created.id);
    });

    it("throws NOT_FOUND for non-existent ID", () => {
      expect(() => queue.getApprovalOrThrow("non-existent")).toThrow(ApprovalQueueError);
      expect(() => queue.getApprovalOrThrow("non-existent")).toThrow(/not found/i);
    });
  });

  describe("getApprovalByRunAndStage", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns most recent approval for run/stage", async () => {
      const input = createTestApprovalInput({ runId: "run-1", stageId: "stage-1" });
      const first = await queue.addApproval(input);
      await queue.completeApproval(first.id, "rejected");

      const second = await queue.addApproval(input);

      const result = queue.getApprovalByRunAndStage("run-1", "stage-1");
      expect(result?.id).toBe(second.id);
    });

    it("returns undefined when not found", () => {
      const result = queue.getApprovalByRunAndStage("run-1", "stage-1");
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Query Approvals Tests
  // ---------------------------------------------------------------------------

  describe("getApprovalsByRun", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns all approvals for a run", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", stageId: "stage-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", stageId: "stage-2" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2", stageId: "stage-1" }));

      const results = queue.getApprovalsByRun("run-1");

      expect(results).toHaveLength(2);
      expect(results.every((a) => a.runId === "run-1")).toBe(true);
    });

    it("returns empty array when no approvals for run", () => {
      const results = queue.getApprovalsByRun("non-existent");
      expect(results).toEqual([]);
    });
  });

  describe("getApprovalsByPipeline", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns approvals matching pipeline name (case-insensitive partial match)", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", pipelineName: "Release Pipeline" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2", pipelineName: "Build Pipeline" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-3", pipelineName: "Release Hotfix" }));

      const results = queue.getApprovalsByPipeline("release");

      expect(results).toHaveLength(2);
      expect(results.every((a) => a.pipelineName.toLowerCase().includes("release"))).toBe(true);
    });
  });

  describe("getApprovalsByUser", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns approvals where user is in approvers list", async () => {
      await queue.addApproval(createTestApprovalInput({
        runId: "run-1",
        approvers: ["user@example.com", "admin@example.com"],
      }));
      await queue.addApproval(createTestApprovalInput({
        runId: "run-2",
        approvers: ["other@example.com"],
      }));
      await queue.addApproval(createTestApprovalInput({
        runId: "run-3",
        approvers: ["USER@EXAMPLE.COM"], // Case-insensitive
      }));

      const results = queue.getApprovalsByUser("user@example.com");

      expect(results).toHaveLength(2);
    });

    it("returns all approvals if no approvers specified on approval", async () => {
      await queue.addApproval(createTestApprovalInput({
        runId: "run-1",
        approvers: undefined,
      }));
      await queue.addApproval(createTestApprovalInput({
        runId: "run-2",
        approvers: [],
      }));

      const results = queue.getApprovalsByUser("anyone@example.com");

      expect(results).toHaveLength(2);
    });
  });

  describe("getPendingApprovals", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns only pending approvals", async () => {
      const pending1 = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      const completed = await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-3" }));
      await queue.completeApproval(completed.id, "approved");

      const results = queue.getPendingApprovals();

      expect(results).toHaveLength(2);
      expect(results.every((a) => a.status === "pending")).toBe(true);
    });

    it("returns approvals sorted oldest first", async () => {
      const first = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));

      const results = queue.getPendingApprovals();

      expect(results[0]?.id).toBe(first.id);
    });
  });

  describe("queryApprovals", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("filters by status", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      const completed = await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      await queue.completeApproval(completed.id, "approved");

      const pending = queue.queryApprovals({ status: "pending" });
      const approved = queue.queryApprovals({ status: "approved" });

      expect(pending).toHaveLength(1);
      expect(approved).toHaveLength(1);
    });

    it("filters by stageId", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", stageId: "deploy" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2", stageId: "test" }));

      const results = queue.queryApprovals({ stageId: "deploy" });

      expect(results).toHaveLength(1);
      expect(results[0]?.stageId).toBe("deploy");
    });

    it("sorts by requestedAt descending by default", async () => {
      const first = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      const second = await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));

      const results = queue.queryApprovals();

      expect(results[0]?.id).toBe(second.id);
      expect(results[1]?.id).toBe(first.id);
    });

    it("sorts ascending when specified", async () => {
      const first = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));

      const results = queue.queryApprovals({ orderDirection: "asc" });

      expect(results[0]?.id).toBe(first.id);
    });

    it("sorts by pipelineName when specified", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", pipelineName: "Beta" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2", pipelineName: "Alpha" }));

      const results = queue.queryApprovals({ orderBy: "pipelineName", orderDirection: "asc" });

      expect(results[0]?.pipelineName).toBe("Alpha");
      expect(results[1]?.pipelineName).toBe("Beta");
    });

    it("applies limit", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-3" }));

      const results = queue.queryApprovals({ limit: 2 });

      expect(results).toHaveLength(2);
    });

    it("filters activeOnly (non-expired pending)", async () => {
      const shortTimeoutQueue = await createAndInitializeApprovalQueue({
        defaultTimeoutMs: -1000, // Already expired
      });

      await shortTimeoutQueue.addApproval(createTestApprovalInput({ runId: "run-1" }));

      const queueWithLongTimeout = await createAndInitializeApprovalQueue({
        defaultTimeoutMs: 3600000, // 1 hour
      });
      await queueWithLongTimeout.addApproval(createTestApprovalInput({ runId: "run-2" }));

      const activeResults = queueWithLongTimeout.queryApprovals({ activeOnly: true });
      const expiredResults = shortTimeoutQueue.queryApprovals({ expiredOnly: true });

      expect(activeResults).toHaveLength(1);
      expect(expiredResults).toHaveLength(1);

      await shortTimeoutQueue.dispose();
      await queueWithLongTimeout.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Complete Approval Tests
  // ---------------------------------------------------------------------------

  describe("completeApproval", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("updates status to approved", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const response = await queue.completeApproval(approval.id, "approved");

      expect(response.decision).toBe("approve");
      expect(queue.getApproval(approval.id)?.status).toBe("approved");
    });

    it("updates status to rejected", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const response = await queue.completeApproval(approval.id, "rejected");

      expect(response.decision).toBe("reject");
      expect(queue.getApproval(approval.id)?.status).toBe("rejected");
    });

    it("includes comment and approvedBy in response", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const response = await queue.completeApproval(approval.id, "approved", {
        comment: "LGTM!",
        approvedBy: "reviewer@example.com",
      });

      expect(response.comment).toBe("LGTM!");
      expect(response.approvedBy).toBe("reviewer@example.com");
      expect(response.approvedAt).toBeDefined();
    });

    it("emits approval.completed event", async () => {
      const handler = vi.fn();
      queue.on("approval.completed", handler);
      const approval = await queue.addApproval(createTestApprovalInput());

      await queue.completeApproval(approval.id, "approved");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          approval: expect.objectContaining({ id: approval.id }),
          response: expect.objectContaining({ decision: "approve" }),
        })
      );
    });

    it("sends notification when hub is configured", async () => {
      const hub = createMockNotificationHub();
      queue.setNotificationHub(hub);
      const approval = await queue.addApproval(createTestApprovalInput());

      await queue.completeApproval(approval.id, "approved");

      expect(hub.notifyApprovalCompletedCalls).toHaveLength(1);
    });

    it("throws NOT_FOUND for non-existent approval", async () => {
      await expect(
        queue.completeApproval("non-existent", "approved")
      ).rejects.toThrow(ApprovalQueueError);
    });

    it("throws ALREADY_COMPLETED when already completed", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());
      await queue.completeApproval(approval.id, "approved");

      await expect(
        queue.completeApproval(approval.id, "rejected")
      ).rejects.toThrow(ApprovalQueueError);
      await expect(
        queue.completeApproval(approval.id, "rejected")
      ).rejects.toThrow(/already completed/i);
    });

    it("throws UNAUTHORIZED when user not in authorizedApprovers", async () => {
      const queueWithApprovers = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["admin@example.com"],
      });
      const approval = await queueWithApprovers.addApproval(createTestApprovalInput());

      await expect(
        queueWithApprovers.completeApproval(approval.id, "approved", {
          approvedBy: "random@example.com",
        })
      ).rejects.toThrow(ApprovalQueueError);
      await expect(
        queueWithApprovers.completeApproval(approval.id, "approved", {
          approvedBy: "random@example.com",
        })
      ).rejects.toThrow(/not authorized/i);

      await queueWithApprovers.dispose();
    });

    it("throws VALIDATION_FAILED when rejection requires comment but none provided", async () => {
      const queueRequireComment = await createAndInitializeApprovalQueue({
        requireRejectComment: true,
      });
      const approval = await queueRequireComment.addApproval(createTestApprovalInput());

      await expect(
        queueRequireComment.completeApproval(approval.id, "rejected")
      ).rejects.toThrow(ApprovalQueueError);
      await expect(
        queueRequireComment.completeApproval(approval.id, "rejected")
      ).rejects.toThrow(/comment is required/i);

      await queueRequireComment.dispose();
    });

    it("allows rejection with comment when requireRejectComment is true", async () => {
      const queueRequireComment = await createAndInitializeApprovalQueue({
        requireRejectComment: true,
      });
      const approval = await queueRequireComment.addApproval(createTestApprovalInput());

      const response = await queueRequireComment.completeApproval(approval.id, "rejected", {
        comment: "Not ready for production",
      });

      expect(response.decision).toBe("reject");
      await queueRequireComment.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel Approval Tests
  // ---------------------------------------------------------------------------

  describe("cancelApproval", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("cancels a pending approval", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const result = await queue.cancelApproval(approval.id);

      expect(result).toBe(true);
      expect(queue.getApproval(approval.id)?.status).toBe("cancelled");
    });

    it("emits approval.cancelled event", async () => {
      const handler = vi.fn();
      queue.on("approval.cancelled", handler);
      const approval = await queue.addApproval(createTestApprovalInput());

      await queue.cancelApproval(approval.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: approval.id }));
    });

    it("returns false for non-existent approval", async () => {
      const result = await queue.cancelApproval("non-existent");
      expect(result).toBe(false);
    });

    it("returns false for already completed approval", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());
      await queue.completeApproval(approval.id, "approved");

      const result = await queue.cancelApproval(approval.id);

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Remove Approval Tests
  // ---------------------------------------------------------------------------

  describe("removeApproval", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("removes approval from queue", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const result = queue.removeApproval(approval.id);

      expect(result).toBe(true);
      expect(queue.getApproval(approval.id)).toBeUndefined();
      expect(queue.approvalCount).toBe(0);
    });

    it("returns false for non-existent approval", () => {
      const result = queue.removeApproval("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("removeApprovalsByRun", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("removes all approvals for a run", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", stageId: "stage-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-1", stageId: "stage-2" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2", stageId: "stage-1" }));

      const count = queue.removeApprovalsByRun("run-1");

      expect(count).toBe(2);
      expect(queue.getApprovalsByRun("run-1")).toHaveLength(0);
      expect(queue.getApprovalsByRun("run-2")).toHaveLength(1);
    });

    it("returns 0 when no approvals for run", () => {
      const count = queue.removeApprovalsByRun("non-existent");
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout Handling Tests
  // ---------------------------------------------------------------------------

  describe("timeout handling", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      vi.useFakeTimers();
      queue = await createAndInitializeApprovalQueue({
        defaultTimeoutMs: 1000, // 1 second for fast tests
      });
    });

    afterEach(async () => {
      await queue.dispose();
      vi.useRealTimers();
    });

    it("checkTimeouts updates expired approvals to timeout status", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));

      // Advance past expiration
      vi.advanceTimersByTime(2000);
      await queue.checkTimeouts();

      const approval = queue.getApprovalsByRun("run-1")[0];
      expect(approval?.status).toBe("timeout");
    });

    it("checkTimeouts uses autoRejectOnTimeout when configured", async () => {
      const autoRejectQueue = createApprovalQueue({
        defaultTimeoutMs: 1000,
        autoRejectOnTimeout: true,
      });
      await autoRejectQueue.initialize();
      await autoRejectQueue.addApproval(createTestApprovalInput({ runId: "run-1" }));

      vi.advanceTimersByTime(2000);
      await autoRejectQueue.checkTimeouts();

      const approval = autoRejectQueue.getApprovalsByRun("run-1")[0];
      expect(approval?.status).toBe("rejected");

      await autoRejectQueue.dispose();
    });

    it("emits approval.timeout event", async () => {
      const handler = vi.fn();
      queue.on("approval.timeout", handler);
      await queue.addApproval(createTestApprovalInput());

      vi.advanceTimersByTime(2000);
      await queue.checkTimeouts();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("sends timeout notification when hub is configured", async () => {
      const hub = createMockNotificationHub();
      queue.setNotificationHub(hub);
      await queue.addApproval(createTestApprovalInput());

      vi.advanceTimersByTime(2000);
      await queue.checkTimeouts();

      expect(hub.notifyApprovalTimeoutCalls).toHaveLength(1);
    });

    it("isExpired returns true for expired approvals", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      expect(queue.isExpired(approval.id)).toBe(false);

      vi.advanceTimersByTime(2000);

      expect(queue.isExpired(approval.id)).toBe(true);
    });

    it("getTimeRemaining returns remaining time", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      const remaining = queue.getTimeRemaining(approval.id);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(1000);

      vi.advanceTimersByTime(500);

      const halfRemaining = queue.getTimeRemaining(approval.id);
      expect(halfRemaining).toBeGreaterThanOrEqual(0);
      expect(halfRemaining).toBeLessThanOrEqual(500);
    });

    it("getTimeRemaining returns 0 when expired", async () => {
      const approval = await queue.addApproval(createTestApprovalInput());

      vi.advanceTimersByTime(2000);

      expect(queue.getTimeRemaining(approval.id)).toBe(0);
    });

    it("getTimeRemaining returns undefined for non-existent approval", () => {
      expect(queue.getTimeRemaining("non-existent")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization Tests
  // ---------------------------------------------------------------------------

  describe("authorization", () => {
    it("isUserAuthorized returns true when no approvers configured", async () => {
      const queue = await createAndInitializeApprovalQueue();

      expect(queue.isUserAuthorized("anyone@example.com")).toBe(true);

      await queue.dispose();
    });

    it("isUserAuthorized checks against configured approvers", async () => {
      const queue = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["admin@example.com", "owner@example.com"],
      });

      expect(queue.isUserAuthorized("admin@example.com")).toBe(true);
      expect(queue.isUserAuthorized("ADMIN@example.com")).toBe(true); // Case-insensitive
      expect(queue.isUserAuthorized("random@example.com")).toBe(false);

      await queue.dispose();
    });

    it("isUserAuthorized supports wildcard patterns", async () => {
      const queue = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["*@example.com", "admin@*"],
      });

      expect(queue.isUserAuthorized("anyone@example.com")).toBe(true);
      expect(queue.isUserAuthorized("admin@other.com")).toBe(true);
      expect(queue.isUserAuthorized("random@other.com")).toBe(false);

      await queue.dispose();
    });

    it("canUserApprove checks both global and approval-specific approvers", async () => {
      const queue = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["admin@example.com", "owner@example.com"],
      });

      const approval = await queue.addApproval(
        createTestApprovalInput({
          runId: "run-1",
          approvers: ["specific@example.com"],
        })
      );

      // User must be in global approvers AND specific approval approvers
      expect(queue.canUserApprove(approval.id, "admin@example.com")).toBe(false);
      expect(queue.canUserApprove(approval.id, "specific@example.com")).toBe(false);

      await queue.dispose();
    });

    it("canUserApprove returns true when no specific approvers on approval", async () => {
      const queue = await createAndInitializeApprovalQueue({
        authorizedApprovers: ["admin@example.com"],
      });

      const approval = await queue.addApproval(
        createTestApprovalInput({
          runId: "run-1",
          approvers: [],
        })
      );

      expect(queue.canUserApprove(approval.id, "admin@example.com")).toBe(true);

      await queue.dispose();
    });

    it("canUserApprove returns false for non-existent approval", async () => {
      const queue = await createAndInitializeApprovalQueue();

      expect(queue.canUserApprove("non-existent", "anyone@example.com")).toBe(false);

      await queue.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Statistics Tests
  // ---------------------------------------------------------------------------

  describe("getStats", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns accurate statistics", async () => {
      const pending1 = await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      const approved = await queue.addApproval(createTestApprovalInput({ runId: "run-3" }));
      await queue.completeApproval(approved.id, "approved");

      const stats = queue.getStats();

      expect(stats.totalApprovals).toBe(3);
      expect(stats.byStatus.pending).toBe(2);
      expect(stats.byStatus.approved).toBe(1);
      expect(stats.byStatus.rejected).toBe(0);
      expect(stats.pendingCount).toBe(2);
      expect(stats.oldestPendingAt).toBe(pending1.requestedAt);
    });

    it("tracks expired pending approvals", async () => {
      vi.useFakeTimers();
      const shortQueue = await createAndInitializeApprovalQueue({
        defaultTimeoutMs: 1000,
      });
      await shortQueue.addApproval(createTestApprovalInput());

      vi.advanceTimersByTime(2000);
      const stats = shortQueue.getStats();

      expect(stats.expiredPendingCount).toBe(1);

      await shortQueue.dispose();
      vi.useRealTimers();
    });

    it("returns zero counts when empty", () => {
      const stats = queue.getStats();

      expect(stats.totalApprovals).toBe(0);
      expect(stats.pendingCount).toBe(0);
      expect(stats.oldestPendingAt).toBeUndefined();
      expect(stats.newestPendingAt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Event Handling Tests
  // ---------------------------------------------------------------------------

  describe("event handling", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("returns unsubscribe function from on()", async () => {
      const handler = vi.fn();
      const unsubscribe = queue.on("approval.added", handler);

      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("off() removes handlers for specific event", async () => {
      const handler = vi.fn();
      queue.on("approval.added", handler);

      queue.off("approval.added");
      await queue.addApproval(createTestApprovalInput());

      expect(handler).not.toHaveBeenCalled();
    });

    it("off() without argument removes all handlers", async () => {
      const addedHandler = vi.fn();
      const completedHandler = vi.fn();
      queue.on("approval.added", addedHandler);
      queue.on("approval.completed", completedHandler);

      queue.off();
      const approval = await queue.addApproval(createTestApprovalInput());
      await queue.completeApproval(approval.id, "approved");

      expect(addedHandler).not.toHaveBeenCalled();
      expect(completedHandler).not.toHaveBeenCalled();
    });

    it("ignores handler errors", async () => {
      const errorHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      const successHandler = vi.fn();
      queue.on("approval.added", errorHandler);
      queue.on("approval.added", successHandler);

      await queue.addApproval(createTestApprovalInput());

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Utility Method Tests
  // ---------------------------------------------------------------------------

  describe("utility methods", () => {
    let queue: ApprovalQueue;

    beforeEach(async () => {
      queue = await createAndInitializeApprovalQueue();
    });

    afterEach(async () => {
      await queue.dispose();
    });

    it("clear() removes all approvals", async () => {
      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));

      queue.clear();

      expect(queue.approvalCount).toBe(0);
      expect(queue.getPendingApprovals()).toEqual([]);
    });

    it("approvalCount returns current count", async () => {
      expect(queue.approvalCount).toBe(0);

      await queue.addApproval(createTestApprovalInput({ runId: "run-1" }));
      expect(queue.approvalCount).toBe(1);

      await queue.addApproval(createTestApprovalInput({ runId: "run-2" }));
      expect(queue.approvalCount).toBe(2);

      queue.removeApproval(queue.getPendingApprovals()[0]!.id);
      expect(queue.approvalCount).toBe(1);
    });
  });
});

// -----------------------------------------------------------------------------
// Error Class Tests
// -----------------------------------------------------------------------------

describe("ApprovalQueueError", () => {
  it("includes error code", () => {
    const error = new ApprovalQueueError("Test message", "NOT_FOUND");

    expect(error.message).toBe("Test message");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.name).toBe("ApprovalQueueError");
  });

  it("supports all error codes", () => {
    const codes = [
      "NOT_FOUND",
      "ALREADY_EXISTS",
      "ALREADY_COMPLETED",
      "VALIDATION_FAILED",
      "NOT_INITIALIZED",
      "TIMEOUT",
      "UNAUTHORIZED",
    ] as const;

    for (const code of codes) {
      const error = new ApprovalQueueError(`Error with ${code}`, code);
      expect(error.code).toBe(code);
    }
  });
});
