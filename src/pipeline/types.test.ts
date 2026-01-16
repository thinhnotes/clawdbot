import { describe, expect, it } from "vitest";
import {
  isValidStageTransition,
  VALID_STAGE_TRANSITIONS,
  type ApprovalConfig,
  type ApprovalRequest,
  type ApprovalStatus,
  type Pipeline,
  type PipelineConfig,
  type PipelineCreate,
  type PipelineStatus,
  type PipelineStoreFile,
  type Stage,
  type StageCreate,
  type StageExecutor,
  type StageStatus,
  type StageTransition,
} from "./types.js";

describe("StageStatus transitions", () => {
  describe("VALID_STAGE_TRANSITIONS", () => {
    it("defines transitions for all stage statuses", () => {
      const allStatuses: StageStatus[] = [
        "pending",
        "running",
        "awaiting_approval",
        "approved",
        "rejected",
        "completed",
        "failed",
      ];

      for (const status of allStatuses) {
        expect(VALID_STAGE_TRANSITIONS[status]).toBeDefined();
        expect(Array.isArray(VALID_STAGE_TRANSITIONS[status])).toBe(true);
      }
    });

    it("allows pending to transition to running only", () => {
      expect(VALID_STAGE_TRANSITIONS.pending).toEqual(["running"]);
    });

    it("allows running to transition to awaiting_approval, completed, or failed", () => {
      expect(VALID_STAGE_TRANSITIONS.running).toEqual([
        "awaiting_approval",
        "completed",
        "failed",
      ]);
    });

    it("allows awaiting_approval to transition to approved or rejected", () => {
      expect(VALID_STAGE_TRANSITIONS.awaiting_approval).toEqual([
        "approved",
        "rejected",
      ]);
    });

    it("allows approved to transition to running or completed", () => {
      expect(VALID_STAGE_TRANSITIONS.approved).toEqual(["running", "completed"]);
    });

    it("allows rejected to transition to pending only", () => {
      expect(VALID_STAGE_TRANSITIONS.rejected).toEqual(["pending"]);
    });

    it("completed is a terminal state with no transitions", () => {
      expect(VALID_STAGE_TRANSITIONS.completed).toEqual([]);
    });

    it("failed can transition to pending (retry)", () => {
      expect(VALID_STAGE_TRANSITIONS.failed).toEqual(["pending"]);
    });
  });

  describe("isValidStageTransition", () => {
    it("returns true for valid pending -> running transition", () => {
      expect(isValidStageTransition("pending", "running")).toBe(true);
    });

    it("returns false for invalid pending -> completed transition", () => {
      expect(isValidStageTransition("pending", "completed")).toBe(false);
    });

    it("returns true for valid running -> awaiting_approval transition", () => {
      expect(isValidStageTransition("running", "awaiting_approval")).toBe(true);
    });

    it("returns true for valid running -> completed transition", () => {
      expect(isValidStageTransition("running", "completed")).toBe(true);
    });

    it("returns true for valid running -> failed transition", () => {
      expect(isValidStageTransition("running", "failed")).toBe(true);
    });

    it("returns false for invalid running -> pending transition", () => {
      expect(isValidStageTransition("running", "pending")).toBe(false);
    });

    it("returns true for valid awaiting_approval -> approved transition", () => {
      expect(isValidStageTransition("awaiting_approval", "approved")).toBe(true);
    });

    it("returns true for valid awaiting_approval -> rejected transition", () => {
      expect(isValidStageTransition("awaiting_approval", "rejected")).toBe(true);
    });

    it("returns false for invalid awaiting_approval -> running transition", () => {
      expect(isValidStageTransition("awaiting_approval", "running")).toBe(false);
    });

    it("returns true for valid approved -> completed transition", () => {
      expect(isValidStageTransition("approved", "completed")).toBe(true);
    });

    it("returns false for any transition from completed", () => {
      const allStatuses: StageStatus[] = [
        "pending",
        "running",
        "awaiting_approval",
        "approved",
        "rejected",
        "completed",
        "failed",
      ];

      for (const status of allStatuses) {
        expect(isValidStageTransition("completed", status)).toBe(false);
      }
    });

    it("returns true for valid failed -> pending transition (retry)", () => {
      expect(isValidStageTransition("failed", "pending")).toBe(true);
    });

    it("returns false for invalid failed -> running transition", () => {
      expect(isValidStageTransition("failed", "running")).toBe(false);
    });
  });
});

describe("Pipeline type validation", () => {
  describe("PipelineCreate", () => {
    it("accepts a valid pipeline create input", () => {
      const executor: StageExecutor = { kind: "manual" };
      const approvalConfig: ApprovalConfig = { required: false };
      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Build",
        order: 1,
        dependencies: [],
        executor,
        approvalConfig,
      };

      const pipelineConfig: PipelineConfig = {
        stopOnFailure: true,
      };

      const pipelineCreate: PipelineCreate = {
        name: "Test Pipeline",
        stages: [stageCreate],
        config: pipelineConfig,
      };

      expect(pipelineCreate.name).toBe("Test Pipeline");
      expect(pipelineCreate.stages).toHaveLength(1);
      expect(pipelineCreate.stages[0].name).toBe("Build");
    });

    it("accepts pipeline with optional description", () => {
      const executor: StageExecutor = { kind: "manual" };
      const approvalConfig: ApprovalConfig = { required: false };
      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Build",
        order: 1,
        dependencies: [],
        executor,
        approvalConfig,
      };

      const pipelineCreate: PipelineCreate = {
        name: "Test Pipeline",
        description: "A test pipeline description",
        stages: [stageCreate],
        config: { stopOnFailure: true },
      };

      expect(pipelineCreate.description).toBe("A test pipeline description");
    });

    it("accepts pipeline with initial status override", () => {
      const executor: StageExecutor = { kind: "manual" };
      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Build",
        order: 1,
        dependencies: [],
        executor,
        approvalConfig: { required: false },
      };

      const pipelineCreate: PipelineCreate = {
        name: "Test Pipeline",
        status: "paused",
        stages: [stageCreate],
        config: { stopOnFailure: true },
      };

      expect(pipelineCreate.status).toBe("paused");
    });
  });

  describe("StageCreate", () => {
    it("accepts a valid stage create with minimal config", () => {
      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Build Stage",
        order: 1,
        dependencies: [],
        executor: { kind: "manual" },
        approvalConfig: { required: false },
      };

      expect(stageCreate.id).toBe("stage-1");
      expect(stageCreate.name).toBe("Build Stage");
      expect(stageCreate.order).toBe(1);
    });

    it("accepts azdo executor with required fields", () => {
      const executor: StageExecutor = {
        kind: "azdo",
        organization: "myorg",
        project: "myproject",
        pipelineId: "123",
      };

      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Azure DevOps Build",
        order: 1,
        dependencies: [],
        executor,
        approvalConfig: { required: false },
      };

      expect(stageCreate.executor.kind).toBe("azdo");
      if (stageCreate.executor.kind === "azdo") {
        expect(stageCreate.executor.organization).toBe("myorg");
        expect(stageCreate.executor.project).toBe("myproject");
        expect(stageCreate.executor.pipelineId).toBe("123");
      }
    });

    it("accepts script executor with command", () => {
      const executor: StageExecutor = {
        kind: "script",
        command: "npm run build",
        workingDir: "/app",
        timeout: 60000,
      };

      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Script Stage",
        order: 1,
        dependencies: [],
        executor,
        approvalConfig: { required: false },
      };

      expect(stageCreate.executor.kind).toBe("script");
      if (stageCreate.executor.kind === "script") {
        expect(stageCreate.executor.command).toBe("npm run build");
        expect(stageCreate.executor.workingDir).toBe("/app");
        expect(stageCreate.executor.timeout).toBe(60000);
      }
    });

    it("accepts approval config with all options", () => {
      const approvalConfig: ApprovalConfig = {
        required: true,
        approvers: ["user1", "user2"],
        timeoutMs: 3600000,
        autoApprove: false,
        autoReject: true,
      };

      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Approval Stage",
        order: 1,
        dependencies: [],
        executor: { kind: "manual" },
        approvalConfig,
      };

      expect(stageCreate.approvalConfig.required).toBe(true);
      expect(stageCreate.approvalConfig.approvers).toEqual(["user1", "user2"]);
      expect(stageCreate.approvalConfig.timeoutMs).toBe(3600000);
      expect(stageCreate.approvalConfig.autoApprove).toBe(false);
      expect(stageCreate.approvalConfig.autoReject).toBe(true);
    });

    it("accepts stage with dependencies", () => {
      const stageCreate: StageCreate = {
        id: "stage-2",
        name: "Deploy Stage",
        order: 2,
        dependencies: ["stage-1", "stage-0"],
        executor: { kind: "manual" },
        approvalConfig: { required: true },
      };

      expect(stageCreate.dependencies).toEqual(["stage-1", "stage-0"]);
    });

    it("accepts stage with optional initial state", () => {
      const stageCreate: StageCreate = {
        id: "stage-1",
        name: "Build Stage",
        order: 1,
        dependencies: [],
        executor: { kind: "manual" },
        approvalConfig: { required: false },
        status: "running",
        state: {
          startedAtMs: 1704067200000,
        },
      };

      expect(stageCreate.status).toBe("running");
      expect(stageCreate.state?.startedAtMs).toBe(1704067200000);
    });
  });

  describe("PipelineConfig", () => {
    it("accepts minimal config", () => {
      const config: PipelineConfig = {
        stopOnFailure: true,
      };

      expect(config.stopOnFailure).toBe(true);
    });

    it("accepts full config with all optional fields", () => {
      const config: PipelineConfig = {
        stopOnFailure: false,
        notificationChannels: ["discord:channel1", "slack:channel2"],
        defaultTimeoutMs: 1800000,
        defaultApprovalConfig: {
          required: true,
          timeoutMs: 3600000,
        },
        metadata: {
          team: "platform",
          env: "staging",
        },
      };

      expect(config.stopOnFailure).toBe(false);
      expect(config.notificationChannels).toEqual([
        "discord:channel1",
        "slack:channel2",
      ]);
      expect(config.defaultTimeoutMs).toBe(1800000);
      expect(config.defaultApprovalConfig?.required).toBe(true);
      expect(config.metadata?.team).toBe("platform");
    });
  });
});

describe("ApprovalRequest validation", () => {
  describe("ApprovalRequest type", () => {
    it("accepts a valid pending approval request", () => {
      const request: ApprovalRequest = {
        id: "approval-123",
        pipelineId: "pipeline-456",
        stageId: "stage-789",
        status: "pending",
        requestedAtMs: 1704067200000,
      };

      expect(request.id).toBe("approval-123");
      expect(request.pipelineId).toBe("pipeline-456");
      expect(request.stageId).toBe("stage-789");
      expect(request.status).toBe("pending");
      expect(request.requestedAtMs).toBe(1704067200000);
    });

    it("accepts approval request with all optional fields", () => {
      const request: ApprovalRequest = {
        id: "approval-123",
        pipelineId: "pipeline-456",
        stageId: "stage-789",
        status: "approved",
        requestedAtMs: 1704067200000,
        requestedBy: "user@example.com",
        expiresAtMs: 1704070800000,
        processedAtMs: 1704068000000,
        processedBy: "admin@example.com",
        comment: "Looks good, approved!",
      };

      expect(request.requestedBy).toBe("user@example.com");
      expect(request.expiresAtMs).toBe(1704070800000);
      expect(request.processedAtMs).toBe(1704068000000);
      expect(request.processedBy).toBe("admin@example.com");
      expect(request.comment).toBe("Looks good, approved!");
    });

    it("accepts all valid approval status values", () => {
      const statuses: ApprovalStatus[] = [
        "pending",
        "approved",
        "rejected",
        "expired",
      ];

      for (const status of statuses) {
        const request: ApprovalRequest = {
          id: `approval-${status}`,
          pipelineId: "pipeline-456",
          stageId: "stage-789",
          status,
          requestedAtMs: 1704067200000,
        };
        expect(request.status).toBe(status);
      }
    });
  });
});

describe("PipelineStoreFile structure", () => {
  it("has correct version and structure", () => {
    const storeFile: PipelineStoreFile = {
      version: 1,
      pipelines: [],
      approvalRequests: [],
    };

    expect(storeFile.version).toBe(1);
    expect(storeFile.pipelines).toEqual([]);
    expect(storeFile.approvalRequests).toEqual([]);
  });

  it("stores pipelines and approval requests together", () => {
    const pipeline: Pipeline = {
      id: "pipeline-1",
      name: "Test Pipeline",
      status: "running",
      createdAtMs: 1704067200000,
      updatedAtMs: 1704067200000,
      stages: [
        {
          id: "stage-1",
          name: "Build",
          status: "awaiting_approval",
          order: 1,
          dependencies: [],
          executor: { kind: "manual" },
          approvalConfig: { required: true },
          state: { startedAtMs: 1704067200000 },
        },
      ],
      config: { stopOnFailure: true },
      currentStageId: "stage-1",
    };

    const approvalRequest: ApprovalRequest = {
      id: "approval-1",
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      status: "pending",
      requestedAtMs: 1704067200000,
    };

    const storeFile: PipelineStoreFile = {
      version: 1,
      pipelines: [pipeline],
      approvalRequests: [approvalRequest],
    };

    expect(storeFile.pipelines).toHaveLength(1);
    expect(storeFile.pipelines[0].id).toBe("pipeline-1");
    expect(storeFile.approvalRequests).toHaveLength(1);
    expect(storeFile.approvalRequests[0].pipelineId).toBe("pipeline-1");
  });
});

describe("StageTransition validation", () => {
  it("accepts a valid stage transition", () => {
    const transition: StageTransition = {
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      fromStatus: "pending",
      toStatus: "running",
      timestamp: 1704067200000,
    };

    expect(transition.pipelineId).toBe("pipeline-1");
    expect(transition.stageId).toBe("stage-1");
    expect(transition.fromStatus).toBe("pending");
    expect(transition.toStatus).toBe("running");
    expect(transition.timestamp).toBe(1704067200000);
  });

  it("accepts transition with optional triggeredBy and reason", () => {
    const transition: StageTransition = {
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      fromStatus: "awaiting_approval",
      toStatus: "rejected",
      timestamp: 1704067200000,
      triggeredBy: "admin@example.com",
      reason: "Security review failed",
    };

    expect(transition.triggeredBy).toBe("admin@example.com");
    expect(transition.reason).toBe("Security review failed");
  });
});

describe("Pipeline type completeness", () => {
  it("Pipeline has all required fields", () => {
    const pipeline: Pipeline = {
      id: "pipeline-1",
      name: "Complete Pipeline",
      description: "A fully complete pipeline",
      status: "pending",
      createdAtMs: 1704067200000,
      updatedAtMs: 1704067200000,
      stages: [],
      config: { stopOnFailure: true },
      currentStageId: undefined,
    };

    expect(pipeline).toHaveProperty("id");
    expect(pipeline).toHaveProperty("name");
    expect(pipeline).toHaveProperty("status");
    expect(pipeline).toHaveProperty("createdAtMs");
    expect(pipeline).toHaveProperty("updatedAtMs");
    expect(pipeline).toHaveProperty("stages");
    expect(pipeline).toHaveProperty("config");
  });

  it("Stage has all required fields", () => {
    const stage: Stage = {
      id: "stage-1",
      name: "Complete Stage",
      description: "A fully complete stage",
      status: "pending",
      order: 1,
      dependencies: [],
      executor: { kind: "manual" },
      approvalConfig: { required: false },
      state: {},
    };

    expect(stage).toHaveProperty("id");
    expect(stage).toHaveProperty("name");
    expect(stage).toHaveProperty("status");
    expect(stage).toHaveProperty("order");
    expect(stage).toHaveProperty("dependencies");
    expect(stage).toHaveProperty("executor");
    expect(stage).toHaveProperty("approvalConfig");
    expect(stage).toHaveProperty("state");
  });

  it("PipelineStatus includes all valid values", () => {
    const allStatuses: PipelineStatus[] = [
      "pending",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ];

    // Verify these are valid by creating pipelines with each status
    for (const status of allStatuses) {
      const pipeline: Pipeline = {
        id: `pipeline-${status}`,
        name: "Test",
        status,
        createdAtMs: 0,
        updatedAtMs: 0,
        stages: [],
        config: { stopOnFailure: true },
      };
      expect(pipeline.status).toBe(status);
    }
  });
});
