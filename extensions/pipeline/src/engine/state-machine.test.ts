/**
 * Unit tests for PipelineStateMachine
 *
 * Tests state transitions, validation, event emission, and concurrent run handling.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  createStateMachine,
  PipelineStateMachine,
  StateTransitionError,
  PIPELINE_STATE_TRANSITIONS,
  STAGE_STATE_TRANSITIONS,
  isPipelineTerminalState,
  isStageTerminalState,
  getValidPipelineTransitions,
  getValidStageTransitions,
} from "./state-machine.js";
import type { CreateRunInput } from "./state-machine.js";
import type { PipelineState, StageState, ApprovalRequest } from "../types.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

function createTestRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    id: `run-${Date.now()}`,
    provider: "mock",
    pipelineId: "test-pipeline",
    pipelineName: "Test Pipeline",
    stages: [
      { id: "stage-1", name: "Build", order: 0 },
      { id: "stage-2", name: "Test", order: 1 },
      { id: "stage-3", name: "Deploy", order: 2 },
    ],
    ...overrides,
  };
}

function createTestApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: `approval-${Date.now()}`,
    runId: "run-1",
    stageId: "stage-1",
    stageName: "Build",
    pipelineName: "Test Pipeline",
    status: "pending",
    requestedAt: Date.now(),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// State Machine Creation Tests
// -----------------------------------------------------------------------------

describe("PipelineStateMachine", () => {
  describe("createStateMachine factory", () => {
    it("creates a new state machine instance", () => {
      const sm = createStateMachine();
      expect(sm).toBeInstanceOf(PipelineStateMachine);
      expect(sm.runCount).toBe(0);
    });
  });

  describe("createRun", () => {
    it("creates a run with initial queued state", async () => {
      const sm = createStateMachine();
      const input = createTestRunInput({ id: "run-1" });

      const run = await sm.createRun(input);

      expect(run.id).toBe("run-1");
      expect(run.state).toBe("queued");
      expect(run.pipelineId).toBe("test-pipeline");
      expect(run.pipelineName).toBe("Test Pipeline");
      expect(run.provider).toBe("mock");
      expect(run.queuedAt).toBeDefined();
      expect(run.startedAt).toBeUndefined();
      expect(run.finishedAt).toBeUndefined();
    });

    it("initializes all stages with pending state", async () => {
      const sm = createStateMachine();
      const input = createTestRunInput();

      const run = await sm.createRun(input);

      expect(run.stages).toHaveLength(3);
      expect(run.stages[0]?.state).toBe("pending");
      expect(run.stages[1]?.state).toBe("pending");
      expect(run.stages[2]?.state).toBe("pending");
    });

    it("preserves stage order from input", async () => {
      const sm = createStateMachine();
      const input = createTestRunInput({
        stages: [
          { id: "s3", name: "Deploy", order: 2 },
          { id: "s1", name: "Build", order: 0 },
          { id: "s2", name: "Test", order: 1 },
        ],
      });

      const run = await sm.createRun(input);

      expect(run.stages[0]?.order).toBe(2);
      expect(run.stages[1]?.order).toBe(0);
      expect(run.stages[2]?.order).toBe(1);
    });

    it("includes optional fields when provided", async () => {
      const sm = createStateMachine();
      const input = createTestRunInput({
        sourceBranch: "main",
        targetBranch: "develop",
        commitId: "abc123",
        commitMessage: "Fix bug",
        triggeredBy: "user@example.com",
        triggerReason: "manual",
        parameters: { env: "prod" },
        webUrl: "https://dev.azure.com/test",
        metadata: { custom: "value" },
      });

      const run = await sm.createRun(input);

      expect(run.sourceBranch).toBe("main");
      expect(run.targetBranch).toBe("develop");
      expect(run.commitId).toBe("abc123");
      expect(run.commitMessage).toBe("Fix bug");
      expect(run.triggeredBy).toBe("user@example.com");
      expect(run.triggerReason).toBe("manual");
      expect(run.parameters).toEqual({ env: "prod" });
      expect(run.webUrl).toBe("https://dev.azure.com/test");
      expect(run.metadata).toEqual({ custom: "value" });
    });

    it("emits pipeline.queued event", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("pipeline.queued", handler);

      const input = createTestRunInput({ id: "run-1" });
      await sm.createRun(input);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
    });
  });

  // ---------------------------------------------------------------------------
  // Run Management Tests
  // ---------------------------------------------------------------------------

  describe("getRun", () => {
    it("returns run by ID", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const run = sm.getRun("run-1");
      expect(run?.id).toBe("run-1");
    });

    it("returns undefined for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.getRun("non-existent")).toBeUndefined();
    });
  });

  describe("getAllRuns", () => {
    it("returns all tracked runs", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));

      const runs = sm.getAllRuns();
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
    });

    it("returns empty array when no runs", () => {
      const sm = createStateMachine();
      expect(sm.getAllRuns()).toEqual([]);
    });
  });

  describe("getRunsByState", () => {
    it("filters runs by state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));
      await sm.transitionPipeline("run-1", "running");

      const runningRuns = sm.getRunsByState("running");
      const queuedRuns = sm.getRunsByState("queued");

      expect(runningRuns).toHaveLength(1);
      expect(runningRuns[0]?.id).toBe("run-1");
      expect(queuedRuns).toHaveLength(1);
      expect(queuedRuns[0]?.id).toBe("run-2");
    });
  });

  describe("removeRun", () => {
    it("removes run by ID", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(sm.removeRun("run-1")).toBe(true);
      expect(sm.getRun("run-1")).toBeUndefined();
      expect(sm.runCount).toBe(0);
    });

    it("returns false for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.removeRun("non-existent")).toBe(false);
    });
  });

  describe("updateRun", () => {
    it("merges updates into run", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const updated = sm.updateRun("run-1", {
        commitMessage: "Updated message",
        metadata: { extra: "data" },
      });

      expect(updated?.commitMessage).toBe("Updated message");
      expect(updated?.metadata).toEqual({ extra: "data" });
    });

    it("does not allow changing id or provider", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1", provider: "mock" }));

      sm.updateRun("run-1", { id: "run-2", provider: "azure-devops" } as never);

      const run = sm.getRun("run-1");
      expect(run?.id).toBe("run-1");
      expect(run?.provider).toBe("mock");
    });

    it("returns undefined for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.updateRun("non-existent", {})).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all runs", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));

      sm.clear();

      expect(sm.runCount).toBe(0);
      expect(sm.getAllRuns()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline State Transition Tests
  // ---------------------------------------------------------------------------

  describe("canTransitionPipeline", () => {
    it("allows valid transitions", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionPipeline("queued", "running")).toBe(true);
      expect(sm.canTransitionPipeline("queued", "cancelled")).toBe(true);
      expect(sm.canTransitionPipeline("running", "succeeded")).toBe(true);
      expect(sm.canTransitionPipeline("running", "failed")).toBe(true);
      expect(sm.canTransitionPipeline("running", "cancelled")).toBe(true);
      expect(sm.canTransitionPipeline("running", "waiting_for_approval")).toBe(true);
      expect(sm.canTransitionPipeline("waiting_for_approval", "running")).toBe(true);
      expect(sm.canTransitionPipeline("waiting_for_approval", "failed")).toBe(true);
      expect(sm.canTransitionPipeline("waiting_for_approval", "cancelled")).toBe(true);
    });

    it("rejects invalid transitions", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionPipeline("queued", "succeeded")).toBe(false);
      expect(sm.canTransitionPipeline("queued", "failed")).toBe(false);
      expect(sm.canTransitionPipeline("running", "queued")).toBe(false);
      expect(sm.canTransitionPipeline("succeeded", "running")).toBe(false);
      expect(sm.canTransitionPipeline("failed", "running")).toBe(false);
      expect(sm.canTransitionPipeline("cancelled", "running")).toBe(false);
    });

    it("rejects transition to same state", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionPipeline("queued", "queued")).toBe(false);
      expect(sm.canTransitionPipeline("running", "running")).toBe(false);
    });

    it("prevents any transitions from terminal states", () => {
      const sm = createStateMachine();
      const terminalStates: PipelineState[] = ["succeeded", "failed", "cancelled", "skipped"];

      for (const state of terminalStates) {
        expect(sm.canTransitionPipeline(state, "running")).toBe(false);
        expect(sm.canTransitionPipeline(state, "queued")).toBe(false);
      }
    });
  });

  describe("transitionPipeline", () => {
    it("transitions run to new state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const run = await sm.transitionPipeline("run-1", "running");

      expect(run.state).toBe("running");
    });

    it("sets startedAt when transitioning to running", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const before = Date.now();
      const run = await sm.transitionPipeline("run-1", "running");
      const after = Date.now();

      expect(run.startedAt).toBeDefined();
      expect(run.startedAt).toBeGreaterThanOrEqual(before);
      expect(run.startedAt).toBeLessThanOrEqual(after);
    });

    it("sets finishedAt and durationMs when transitioning to terminal state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionPipeline("run-1", "running");

      const before = Date.now();
      const run = await sm.transitionPipeline("run-1", "succeeded");
      const after = Date.now();

      expect(run.finishedAt).toBeDefined();
      expect(run.finishedAt).toBeGreaterThanOrEqual(before);
      expect(run.finishedAt).toBeLessThanOrEqual(after);
      expect(run.durationMs).toBeDefined();
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(run.result).toBe("succeeded");
    });

    it("sets result for terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));
      await sm.createRun(createTestRunInput({ id: "run-3" }));
      await sm.transitionPipeline("run-1", "running");
      await sm.transitionPipeline("run-2", "running");
      await sm.transitionPipeline("run-3", "running");

      const succeeded = await sm.transitionPipeline("run-1", "succeeded");
      const failed = await sm.transitionPipeline("run-2", "failed");
      const cancelled = await sm.transitionPipeline("run-3", "cancelled");

      expect(succeeded.result).toBe("succeeded");
      expect(failed.result).toBe("failed");
      expect(cancelled.result).toBe("cancelled");
    });

    it("respects custom timestamp option", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const customTime = 1704067200000; // 2024-01-01 00:00:00
      const run = await sm.transitionPipeline("run-1", "running", { timestamp: customTime });

      expect(run.startedAt).toBe(customTime);
    });

    it("merges metadata option", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1", metadata: { existing: "value" } }));

      await sm.transitionPipeline("run-1", "running", { metadata: { new: "data" } });

      const run = sm.getRun("run-1");
      expect(run?.metadata).toEqual({ existing: "value", new: "data" });
    });

    it("throws StateTransitionError for non-existent run", async () => {
      const sm = createStateMachine();

      await expect(sm.transitionPipeline("non-existent", "running")).rejects.toThrow(
        StateTransitionError
      );
    });

    it("throws StateTransitionError for invalid transition", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await expect(sm.transitionPipeline("run-1", "succeeded")).rejects.toThrow(
        StateTransitionError
      );
    });

    it("includes details in StateTransitionError", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      try {
        await sm.transitionPipeline("run-1", "succeeded");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StateTransitionError);
        const ste = error as StateTransitionError;
        expect(ste.runId).toBe("run-1");
        expect(ste.currentState).toBe("queued");
        expect(ste.targetState).toBe("succeeded");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline State Transition Event Emission Tests
  // ---------------------------------------------------------------------------

  describe("pipeline state transition events", () => {
    it("emits pipeline.started when transitioning from queued to running", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("pipeline.started", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await sm.transitionPipeline("run-1", "running");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1", state: "running" }));
    });

    it("emits pipeline.completed for terminal states", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("pipeline.completed", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionPipeline("run-1", "running");

      await sm.transitionPipeline("run-1", "succeeded");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: "run-1", state: "succeeded" })
      );
    });

    it("does not emit pipeline.started when resuming from approval", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("pipeline.started", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionPipeline("run-1", "running");
      await sm.transitionPipeline("run-1", "waiting_for_approval");

      await sm.transitionPipeline("run-1", "running");

      // Only called once from the first queued -> running transition
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Stage State Transition Tests
  // ---------------------------------------------------------------------------

  describe("canTransitionStage", () => {
    it("allows valid transitions", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionStage("pending", "queued")).toBe(true);
      expect(sm.canTransitionStage("pending", "running")).toBe(true);
      expect(sm.canTransitionStage("pending", "skipped")).toBe(true);
      expect(sm.canTransitionStage("queued", "running")).toBe(true);
      expect(sm.canTransitionStage("running", "succeeded")).toBe(true);
      expect(sm.canTransitionStage("running", "failed")).toBe(true);
      expect(sm.canTransitionStage("running", "waiting_for_approval")).toBe(true);
      expect(sm.canTransitionStage("waiting_for_approval", "approved")).toBe(true);
      expect(sm.canTransitionStage("waiting_for_approval", "rejected")).toBe(true);
      expect(sm.canTransitionStage("approved", "running")).toBe(true);
      expect(sm.canTransitionStage("approved", "succeeded")).toBe(true);
    });

    it("rejects invalid transitions", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionStage("pending", "succeeded")).toBe(false);
      expect(sm.canTransitionStage("running", "pending")).toBe(false);
      expect(sm.canTransitionStage("succeeded", "running")).toBe(false);
      expect(sm.canTransitionStage("failed", "running")).toBe(false);
      expect(sm.canTransitionStage("rejected", "running")).toBe(false);
    });

    it("rejects transition to same state", () => {
      const sm = createStateMachine();

      expect(sm.canTransitionStage("pending", "pending")).toBe(false);
      expect(sm.canTransitionStage("running", "running")).toBe(false);
    });

    it("prevents any transitions from terminal states", () => {
      const sm = createStateMachine();
      const terminalStates: StageState[] = ["succeeded", "failed", "cancelled", "skipped", "rejected"];

      for (const state of terminalStates) {
        expect(sm.canTransitionStage(state, "running")).toBe(false);
        expect(sm.canTransitionStage(state, "pending")).toBe(false);
      }
    });
  });

  describe("transitionStage", () => {
    it("transitions stage to new state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const stage = await sm.transitionStage("run-1", "stage-1", "running");

      expect(stage.state).toBe("running");
    });

    it("sets startedAt when transitioning to running", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const before = Date.now();
      const stage = await sm.transitionStage("run-1", "stage-1", "running");
      const after = Date.now();

      expect(stage.startedAt).toBeDefined();
      expect(stage.startedAt).toBeGreaterThanOrEqual(before);
      expect(stage.startedAt).toBeLessThanOrEqual(after);
    });

    it("sets finishedAt and durationMs when transitioning to terminal state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      const stage = await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(stage.finishedAt).toBeDefined();
      expect(stage.durationMs).toBeDefined();
      expect(stage.result).toBe("succeeded");
    });

    it("sets result for terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-2", "running");

      const succeeded = await sm.transitionStage("run-1", "stage-1", "succeeded");
      const failed = await sm.transitionStage("run-1", "stage-2", "failed");

      expect(succeeded.result).toBe("succeeded");
      expect(failed.result).toBe("failed");
    });

    it("sets result to failed for rejected state", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval");

      const rejected = await sm.transitionStage("run-1", "stage-1", "rejected");

      expect(rejected.result).toBe("failed");
    });

    it("stores approval request when transitioning to waiting_for_approval", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      const approval = createTestApproval();
      const stage = await sm.transitionStage("run-1", "stage-1", "waiting_for_approval", {
        approval,
      });

      expect(stage.approval).toBeDefined();
      expect(stage.approval?.id).toBe(approval.id);
    });

    it("stores error message when provided", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      const stage = await sm.transitionStage("run-1", "stage-1", "failed", {
        error: "Build compilation error",
      });

      expect(stage.error).toBe("Build compilation error");
    });

    it("throws StateTransitionError for non-existent run", async () => {
      const sm = createStateMachine();

      await expect(sm.transitionStage("non-existent", "stage-1", "running")).rejects.toThrow(
        StateTransitionError
      );
    });

    it("throws StateTransitionError for non-existent stage", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await expect(sm.transitionStage("run-1", "non-existent", "running")).rejects.toThrow(
        StateTransitionError
      );
    });

    it("throws StateTransitionError for invalid transition", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await expect(sm.transitionStage("run-1", "stage-1", "succeeded")).rejects.toThrow(
        StateTransitionError
      );
    });

    it("includes stageId in StateTransitionError", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      try {
        await sm.transitionStage("run-1", "stage-1", "succeeded");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(StateTransitionError);
        const ste = error as StateTransitionError;
        expect(ste.runId).toBe("run-1");
        expect(ste.stageId).toBe("stage-1");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stage State Transition Event Emission Tests
  // ---------------------------------------------------------------------------

  describe("stage state transition events", () => {
    it("emits stage.started when transitioning to running", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("stage.started", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await sm.transitionStage("run-1", "stage-1", "running");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          run: expect.objectContaining({ id: "run-1" }),
          stage: expect.objectContaining({ id: "stage-1", state: "running" }),
        })
      );
    });

    it("emits stage.completed for terminal states", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("stage.completed", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          run: expect.objectContaining({ id: "run-1" }),
          stage: expect.objectContaining({ id: "stage-1", state: "succeeded" }),
        })
      );
    });

    it("emits stage.waiting_for_approval with approval info", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("stage.waiting_for_approval", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      const approval = createTestApproval();
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval", { approval });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          approval: expect.objectContaining({ id: approval.id }),
        })
      );
    });

    it("emits approval.completed when stage is approved or rejected", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("approval.completed", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval");

      await sm.transitionStage("run-1", "stage-1", "approved", {
        approvalResponse: {
          approvalId: "approval-1",
          decision: "approve",
          approvedBy: "user@example.com",
          approvedAt: Date.now(),
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            decision: "approve",
            approvedBy: "user@example.com",
          }),
        })
      );
    });

    it("emits stage.started when resuming from approved", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("stage.started", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval");
      await sm.transitionStage("run-1", "stage-1", "approved");

      await sm.transitionStage("run-1", "stage-1", "running");

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Helper Method Tests
  // ---------------------------------------------------------------------------

  describe("getStage", () => {
    it("returns stage by ID", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const stage = sm.getStage("run-1", "stage-1");
      expect(stage?.id).toBe("stage-1");
      expect(stage?.name).toBe("Build");
    });

    it("returns undefined for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.getStage("non-existent", "stage-1")).toBeUndefined();
    });

    it("returns undefined for non-existent stage", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      expect(sm.getStage("run-1", "non-existent")).toBeUndefined();
    });
  });

  describe("getStages", () => {
    it("returns all stages for a run", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      const stages = sm.getStages("run-1");
      expect(stages).toHaveLength(3);
    });

    it("returns empty array for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.getStages("non-existent")).toEqual([]);
    });
  });

  describe("isPipelineTerminal", () => {
    it("returns true for terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionPipeline("run-1", "running");
      await sm.transitionPipeline("run-1", "succeeded");

      expect(sm.isPipelineTerminal("run-1")).toBe(true);
    });

    it("returns false for non-terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(sm.isPipelineTerminal("run-1")).toBe(false);

      await sm.transitionPipeline("run-1", "running");
      expect(sm.isPipelineTerminal("run-1")).toBe(false);
    });

    it("returns false for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.isPipelineTerminal("non-existent")).toBe(false);
    });
  });

  describe("isStageTerminal", () => {
    it("returns true for terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(sm.isStageTerminal("run-1", "stage-1")).toBe(true);
    });

    it("returns false for non-terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(sm.isStageTerminal("run-1", "stage-1")).toBe(false);

      await sm.transitionStage("run-1", "stage-1", "running");
      expect(sm.isStageTerminal("run-1", "stage-1")).toBe(false);
    });

    it("returns false for non-existent stage", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      expect(sm.isStageTerminal("run-1", "non-existent")).toBe(false);
    });
  });

  describe("getPendingStages", () => {
    it("returns only pending stages", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");

      const pending = sm.getPendingStages("run-1");
      expect(pending).toHaveLength(2);
      expect(pending.map((s) => s.id)).toEqual(["stage-2", "stage-3"]);
    });

    it("returns empty array when no pending stages", async () => {
      const sm = createStateMachine();
      await sm.createRun(
        createTestRunInput({
          id: "run-1",
          stages: [{ id: "stage-1", name: "Build", order: 0 }],
        })
      );
      await sm.transitionStage("run-1", "stage-1", "running");

      expect(sm.getPendingStages("run-1")).toEqual([]);
    });
  });

  describe("getNextStage", () => {
    it("returns first pending stage", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(sm.getNextStage("run-1")?.id).toBe("stage-1");

      await sm.transitionStage("run-1", "stage-1", "running");
      expect(sm.getNextStage("run-1")?.id).toBe("stage-2");
    });

    it("returns undefined when no pending stages", async () => {
      const sm = createStateMachine();
      await sm.createRun(
        createTestRunInput({
          id: "run-1",
          stages: [{ id: "stage-1", name: "Build", order: 0 }],
        })
      );
      await sm.transitionStage("run-1", "stage-1", "running");

      expect(sm.getNextStage("run-1")).toBeUndefined();
    });

    it("returns undefined for non-existent run", () => {
      const sm = createStateMachine();
      expect(sm.getNextStage("non-existent")).toBeUndefined();
    });
  });

  describe("getApprovalPendingStages", () => {
    it("returns stages waiting for approval", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval");

      const waiting = sm.getApprovalPendingStages("run-1");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.id).toBe("stage-1");
    });

    it("returns empty array when no stages waiting", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(sm.getApprovalPendingStages("run-1")).toEqual([]);
    });
  });

  describe("areAllStagesComplete", () => {
    it("returns true when all stages are in terminal states", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "succeeded");
      await sm.transitionStage("run-1", "stage-2", "running");
      await sm.transitionStage("run-1", "stage-2", "succeeded");
      await sm.transitionStage("run-1", "stage-3", "skipped");

      expect(sm.areAllStagesComplete("run-1")).toBe(true);
    });

    it("returns false when some stages are not complete", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(sm.areAllStagesComplete("run-1")).toBe(false);
    });
  });

  describe("hasFailedStage", () => {
    it("returns true when any stage has failed", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "failed");

      expect(sm.hasFailedStage("run-1")).toBe(true);
    });

    it("returns true when any stage is rejected", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "waiting_for_approval");
      await sm.transitionStage("run-1", "stage-1", "rejected");

      expect(sm.hasFailedStage("run-1")).toBe(true);
    });

    it("returns false when no stages have failed", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(sm.hasFailedStage("run-1")).toBe(false);
    });
  });

  describe("skipRemainingStages", () => {
    it("skips all pending stages when no afterStageId provided", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      await sm.skipRemainingStages("run-1");

      const stages = sm.getStages("run-1");
      expect(stages.every((s) => s.state === "skipped")).toBe(true);
    });

    it("skips only stages after specified stage", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "failed");

      await sm.skipRemainingStages("run-1", "stage-1");

      expect(sm.getStage("run-1", "stage-1")?.state).toBe("failed");
      expect(sm.getStage("run-1", "stage-2")?.state).toBe("skipped");
      expect(sm.getStage("run-1", "stage-3")?.state).toBe("skipped");
    });

    it("does nothing for non-existent run", async () => {
      const sm = createStateMachine();
      // Should not throw
      await sm.skipRemainingStages("non-existent");
    });
  });

  // ---------------------------------------------------------------------------
  // Event Handling Tests
  // ---------------------------------------------------------------------------

  describe("event handling", () => {
    it("returns unsubscribe function from on()", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();

      const unsubscribe = sm.on("pipeline.queued", handler);
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      await sm.createRun(createTestRunInput({ id: "run-2" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("off() removes handlers for specific event", async () => {
      const sm = createStateMachine();
      const handler = vi.fn();
      sm.on("pipeline.queued", handler);

      sm.off("pipeline.queued");
      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("off() without argument removes all handlers", async () => {
      const sm = createStateMachine();
      const queuedHandler = vi.fn();
      const startedHandler = vi.fn();
      sm.on("pipeline.queued", queuedHandler);
      sm.on("pipeline.started", startedHandler);

      sm.off();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.transitionPipeline("run-1", "running");

      expect(queuedHandler).not.toHaveBeenCalled();
      expect(startedHandler).not.toHaveBeenCalled();
    });

    it("ignores handler errors", async () => {
      const sm = createStateMachine();
      const errorHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      const successHandler = vi.fn();
      sm.on("pipeline.queued", errorHandler);
      sm.on("pipeline.queued", successHandler);

      await sm.createRun(createTestRunInput({ id: "run-1" }));

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent Run Handling Tests
  // ---------------------------------------------------------------------------

  describe("concurrent run handling", () => {
    it("tracks multiple runs independently", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));
      await sm.createRun(createTestRunInput({ id: "run-3" }));

      await sm.transitionPipeline("run-1", "running");
      await sm.transitionPipeline("run-2", "cancelled");

      expect(sm.getRun("run-1")?.state).toBe("running");
      expect(sm.getRun("run-2")?.state).toBe("cancelled");
      expect(sm.getRun("run-3")?.state).toBe("queued");
    });

    it("stage transitions in one run do not affect others", async () => {
      const sm = createStateMachine();
      await sm.createRun(createTestRunInput({ id: "run-1" }));
      await sm.createRun(createTestRunInput({ id: "run-2" }));

      await sm.transitionStage("run-1", "stage-1", "running");
      await sm.transitionStage("run-1", "stage-1", "succeeded");

      expect(sm.getStage("run-2", "stage-1")?.state).toBe("pending");
    });

    it("runCount tracks active runs correctly", async () => {
      const sm = createStateMachine();
      expect(sm.runCount).toBe(0);

      await sm.createRun(createTestRunInput({ id: "run-1" }));
      expect(sm.runCount).toBe(1);

      await sm.createRun(createTestRunInput({ id: "run-2" }));
      expect(sm.runCount).toBe(2);

      sm.removeRun("run-1");
      expect(sm.runCount).toBe(1);
    });
  });
});

// -----------------------------------------------------------------------------
// Utility Function Tests
// -----------------------------------------------------------------------------

describe("utility functions", () => {
  describe("isPipelineTerminalState", () => {
    it("returns true for terminal states", () => {
      expect(isPipelineTerminalState("succeeded")).toBe(true);
      expect(isPipelineTerminalState("failed")).toBe(true);
      expect(isPipelineTerminalState("cancelled")).toBe(true);
      expect(isPipelineTerminalState("skipped")).toBe(true);
    });

    it("returns false for non-terminal states", () => {
      expect(isPipelineTerminalState("queued")).toBe(false);
      expect(isPipelineTerminalState("running")).toBe(false);
      expect(isPipelineTerminalState("waiting_for_approval")).toBe(false);
    });
  });

  describe("isStageTerminalState", () => {
    it("returns true for terminal states", () => {
      expect(isStageTerminalState("succeeded")).toBe(true);
      expect(isStageTerminalState("failed")).toBe(true);
      expect(isStageTerminalState("cancelled")).toBe(true);
      expect(isStageTerminalState("skipped")).toBe(true);
      expect(isStageTerminalState("rejected")).toBe(true);
    });

    it("returns false for non-terminal states", () => {
      expect(isStageTerminalState("pending")).toBe(false);
      expect(isStageTerminalState("queued")).toBe(false);
      expect(isStageTerminalState("running")).toBe(false);
      expect(isStageTerminalState("waiting_for_approval")).toBe(false);
      expect(isStageTerminalState("approved")).toBe(false);
    });
  });

  describe("getValidPipelineTransitions", () => {
    it("returns valid transitions for each state", () => {
      expect(getValidPipelineTransitions("queued").sort()).toEqual(["cancelled", "running"]);
      expect(getValidPipelineTransitions("running").sort()).toEqual([
        "cancelled",
        "failed",
        "succeeded",
        "waiting_for_approval",
      ]);
      expect(getValidPipelineTransitions("succeeded")).toEqual([]);
      expect(getValidPipelineTransitions("failed")).toEqual([]);
    });
  });

  describe("getValidStageTransitions", () => {
    it("returns valid transitions for each state", () => {
      expect(getValidStageTransitions("pending").sort()).toEqual([
        "cancelled",
        "queued",
        "running",
        "skipped",
      ]);
      expect(getValidStageTransitions("running").sort()).toEqual([
        "cancelled",
        "failed",
        "succeeded",
        "waiting_for_approval",
      ]);
      expect(getValidStageTransitions("waiting_for_approval").sort()).toEqual([
        "approved",
        "cancelled",
        "rejected",
      ]);
      expect(getValidStageTransitions("succeeded")).toEqual([]);
      expect(getValidStageTransitions("rejected")).toEqual([]);
    });
  });
});

// -----------------------------------------------------------------------------
// State Transition Definition Tests
// -----------------------------------------------------------------------------

describe("state transition definitions", () => {
  describe("PIPELINE_STATE_TRANSITIONS", () => {
    it("covers all pipeline states", () => {
      const expectedStates: PipelineState[] = [
        "queued",
        "running",
        "waiting_for_approval",
        "succeeded",
        "failed",
        "cancelled",
        "skipped",
      ];

      expect(Object.keys(PIPELINE_STATE_TRANSITIONS).sort()).toEqual(expectedStates.sort());
    });
  });

  describe("STAGE_STATE_TRANSITIONS", () => {
    it("covers all stage states", () => {
      const expectedStates: StageState[] = [
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
      ];

      expect(Object.keys(STAGE_STATE_TRANSITIONS).sort()).toEqual(expectedStates.sort());
    });
  });
});
