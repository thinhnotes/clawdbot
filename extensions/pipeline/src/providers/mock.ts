/**
 * Mock Pipeline Provider
 *
 * A mock provider for development and testing without external dependencies.
 * Simulates pipeline execution with configurable stages, delays, and approval gates.
 *
 * Features:
 * - Simulated pipeline execution with configurable delays
 * - Configurable stage counts and approval gates
 * - Simulated failures with configurable probability
 * - Event emission for state changes
 * - In-memory storage of pipeline runs
 *
 * @example
 * ```typescript
 * const provider = new MockProvider({
 *   stageCount: 3,
 *   simulateApprovalGates: true,
 *   simulatedDelayMs: 1000,
 * });
 *
 * const result = await provider.triggerPipeline({
 *   pipelineId: "my-pipeline",
 *   branch: "main",
 * });
 * ```
 */

import { randomUUID } from "crypto";
import type {
  ApprovalId,
  ApprovalRequest,
  ApproveStageInput,
  CancelPipelineInput,
  GetLogsInput,
  GetLogsResult,
  GetPipelineHistoryInput,
  GetPipelineHistoryResult,
  GetPipelineStatusInput,
  ListPipelinesResult,
  LogEntry,
  PipelineDefinition,
  PipelineRun,
  PipelineState,
  ProviderEvent,
  ProviderName,
  RejectStageInput,
  Stage,
  StageId,
  TriggerPipelineInput,
  TriggerPipelineResult,
  WebhookContext,
  WebhookParseResult,
  WebhookVerificationResult,
} from "../types.js";
import {
  type MockProviderConfig,
  type PipelineProvider,
  PipelineProviderError,
} from "./base.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Event handler for mock provider events
 */
type MockEventHandler = (event: ProviderEvent) => void | Promise<void>;

/**
 * Internal representation of a mock pipeline run
 */
interface MockPipelineRun extends PipelineRun {
  /** Timer for automatic stage progression */
  progressTimer?: NodeJS.Timeout;
  /** Logs generated during execution */
  logs: Map<string, LogEntry[]>;
  /** Pending approval requests by approval ID */
  approvals: Map<ApprovalId, ApprovalRequest>;
}

/**
 * Mock pipeline definition
 */
interface MockPipelineDefinition extends PipelineDefinition {
  /** Number of stages for this pipeline */
  stageCount: number;
  /** Stages that have approval gates */
  approvalStages: number[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_STAGE_COUNT = 3;
const DEFAULT_SIMULATED_DELAY_MS = 500;
const DEFAULT_FAILURE_PROBABILITY = 0;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// -----------------------------------------------------------------------------
// MockProvider Implementation
// -----------------------------------------------------------------------------

/**
 * Mock pipeline provider for development and testing.
 *
 * Provides a fully functional pipeline simulation without external dependencies.
 * Supports configurable stages, approval gates, delays, and failure simulation.
 */
export class MockProvider implements PipelineProvider {
  readonly name: ProviderName = "mock";

  private readonly config: Required<MockProviderConfig>;
  private readonly runs: Map<string, MockPipelineRun> = new Map();
  private readonly pipelines: Map<string, MockPipelineDefinition> = new Map();
  private readonly eventHandlers: Set<MockEventHandler> = new Set();

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      pollingIntervalMs: config.pollingIntervalMs ?? 1000,
      requestTimeoutMs: config.requestTimeoutMs ?? 30000,
      simulatedDelayMs: config.simulatedDelayMs ?? DEFAULT_SIMULATED_DELAY_MS,
      stageCount: config.stageCount ?? DEFAULT_STAGE_COUNT,
      simulateApprovalGates: config.simulateApprovalGates ?? false,
      failureProbability: config.failureProbability ?? DEFAULT_FAILURE_PROBABILITY,
    };

    // Initialize default pipelines
    this.initializeDefaultPipelines();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // No-op for mock provider - already initialized in constructor
  }

  async dispose(): Promise<void> {
    // Clean up all running timers
    for (const run of this.runs.values()) {
      if (run.progressTimer) {
        clearTimeout(run.progressTimer);
        run.progressTimer = undefined;
      }
    }
    this.runs.clear();
    this.eventHandlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to mock provider events
   */
  onEvent(handler: MockEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private async emitEvent(event: ProviderEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      try {
        await handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook Handling (Mock - always succeeds)
  // ---------------------------------------------------------------------------

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    // Mock webhook verification always succeeds
    return { ok: true };
  }

  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult {
    // Parse mock webhook events from the request body
    try {
      const body = JSON.parse(ctx.rawBody);

      // If body contains a provider event, return it
      if (body.type && body.runId) {
        return {
          events: [body as ProviderEvent],
          statusCode: 200,
        };
      }

      // Otherwise return empty events
      return { events: [], statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline Operations
  // ---------------------------------------------------------------------------

  async triggerPipeline(input: TriggerPipelineInput): Promise<TriggerPipelineResult> {
    const { pipelineId, branch, parameters, commitId } = input;

    // Validate pipeline exists
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      throw new PipelineProviderError(
        `Pipeline not found: ${pipelineId}`,
        "NOT_FOUND",
        "mock",
      );
    }

    // Create run ID
    const runId = randomUUID();
    const providerRunId = `mock-run-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Create stages
    const stages = this.createStages(pipeline);

    // Create the run
    const now = Date.now();
    const run: MockPipelineRun = {
      id: runId,
      providerRunId,
      provider: "mock",
      pipelineId,
      pipelineName: pipeline.name,
      state: "queued",
      sourceBranch: branch ?? pipeline.defaultBranch ?? "main",
      commitId: commitId ?? `mock-commit-${Date.now().toString(16)}`,
      commitMessage: "Mock commit message",
      triggeredBy: "mock-user",
      triggerReason: "manual",
      stages,
      parameters,
      queuedAt: now,
      webUrl: `https://mock.example.com/pipeline/${pipelineId}/run/${providerRunId}`,
      logs: new Map(),
      approvals: new Map(),
    };

    // Store the run
    this.runs.set(runId, run);

    // Emit queued event
    await this.emitEvent({
      type: "pipeline.queued",
      id: randomUUID(),
      runId,
      providerRunId,
      timestamp: now,
      pipelineName: pipeline.name,
    });

    // Start pipeline execution asynchronously
    this.startPipelineExecution(runId);

    return {
      runId,
      providerRunId,
      webUrl: run.webUrl,
      status: "queued",
    };
  }

  async getPipelineStatus(input: GetPipelineStatusInput): Promise<PipelineRun> {
    const run = this.findRun(input.runId, input.providerRunId);

    // Return a copy without internal properties
    return this.toPublicRun(run);
  }

  async getStageStatus(input: GetPipelineStatusInput, stageId: StageId): Promise<Stage | null> {
    const run = this.findRun(input.runId, input.providerRunId);
    const stage = run.stages.find((s) => s.id === stageId);
    return stage ?? null;
  }

  async cancelPipeline(input: CancelPipelineInput): Promise<void> {
    const run = this.findRun(input.runId, input.providerRunId);

    // Check if cancellation is possible
    if (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") {
      throw new PipelineProviderError(
        `Cannot cancel pipeline in state: ${run.state}`,
        "INVALID_REQUEST",
        "mock",
      );
    }

    // Stop execution timer
    if (run.progressTimer) {
      clearTimeout(run.progressTimer);
      run.progressTimer = undefined;
    }

    // Update state
    run.state = "cancelled";
    run.finishedAt = Date.now();
    run.result = "cancelled";

    // Cancel all non-terminal stages
    for (const stage of run.stages) {
      if (!["succeeded", "failed", "cancelled", "skipped", "rejected"].includes(stage.state)) {
        stage.state = "cancelled";
        stage.finishedAt = Date.now();
        stage.result = "cancelled";
      }
    }

    // Emit event
    await this.emitEvent({
      type: "pipeline.completed",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      pipelineName: run.pipelineName,
      result: "cancelled",
    });
  }

  // ---------------------------------------------------------------------------
  // Approval Operations
  // ---------------------------------------------------------------------------

  async approveStage(input: ApproveStageInput): Promise<void> {
    const run = this.findRun(input.runId, input.providerRunId);
    const approval = run.approvals.get(input.approvalId);

    if (!approval) {
      throw new PipelineProviderError(
        `Approval not found: ${input.approvalId}`,
        "NOT_FOUND",
        "mock",
      );
    }

    // Check if already processed
    if (approval.status !== "pending") {
      throw new PipelineProviderError(
        `Approval already processed: ${approval.status}`,
        "ALREADY_APPROVED",
        "mock",
      );
    }

    // Check if expired
    if (approval.expiresAt && Date.now() > approval.expiresAt) {
      approval.status = "timeout";
      throw new PipelineProviderError(
        "Approval has expired",
        "APPROVAL_EXPIRED",
        "mock",
      );
    }

    // Update approval status
    approval.status = "approved";

    // Find and update the stage
    const stage = run.stages.find((s) => s.id === approval.stageId);
    if (stage) {
      stage.state = "approved";

      // Emit approval completed event
      await this.emitEvent({
        type: "stage.approval_completed",
        id: randomUUID(),
        runId: run.id,
        providerRunId: run.providerRunId,
        timestamp: Date.now(),
        stageId: stage.id,
        stageName: stage.name,
        approvalId: approval.id,
        decision: "approve",
        approvedBy: "mock-approver",
        comment: input.comment,
      });

      // Continue pipeline execution
      if (run.state === "waiting_for_approval") {
        run.state = "running";
        this.continueStageExecution(run.id, stage.id);
      }
    }
  }

  async rejectStage(input: RejectStageInput): Promise<void> {
    const run = this.findRun(input.runId, input.providerRunId);
    const approval = run.approvals.get(input.approvalId);

    if (!approval) {
      throw new PipelineProviderError(
        `Approval not found: ${input.approvalId}`,
        "NOT_FOUND",
        "mock",
      );
    }

    // Check if already processed
    if (approval.status !== "pending") {
      throw new PipelineProviderError(
        `Approval already processed: ${approval.status}`,
        "ALREADY_APPROVED",
        "mock",
      );
    }

    // Update approval status
    approval.status = "rejected";

    // Find and update the stage
    const stage = run.stages.find((s) => s.id === approval.stageId);
    if (stage) {
      stage.state = "rejected";
      stage.finishedAt = Date.now();
      if (stage.startedAt) {
        stage.durationMs = stage.finishedAt - stage.startedAt;
      }

      // Emit approval completed event
      await this.emitEvent({
        type: "stage.approval_completed",
        id: randomUUID(),
        runId: run.id,
        providerRunId: run.providerRunId,
        timestamp: Date.now(),
        stageId: stage.id,
        stageName: stage.name,
        approvalId: approval.id,
        decision: "reject",
        approvedBy: "mock-approver",
        comment: input.comment,
      });

      // Mark pipeline as failed due to rejection
      run.state = "failed";
      run.finishedAt = Date.now();
      run.result = "failed";

      // Skip remaining stages
      for (const s of run.stages) {
        if (s.order > stage.order && s.state === "pending") {
          s.state = "skipped";
        }
      }

      // Emit pipeline completed event
      await this.emitEvent({
        type: "pipeline.completed",
        id: randomUUID(),
        runId: run.id,
        providerRunId: run.providerRunId,
        timestamp: Date.now(),
        pipelineName: run.pipelineName,
        result: "failed",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Log Retrieval
  // ---------------------------------------------------------------------------

  async getLogs(input: GetLogsInput): Promise<GetLogsResult> {
    const run = this.findRun(input.runId, input.providerRunId);

    // Generate logs for the specified stage or all stages
    const logs: LogEntry[] = [];

    if (input.stageId) {
      // Get logs for specific stage
      const stageLogs = run.logs.get(input.stageId) ?? [];
      logs.push(...stageLogs);

      // If no logs yet, generate some mock logs
      if (logs.length === 0) {
        const stage = run.stages.find((s) => s.id === input.stageId);
        if (stage) {
          logs.push(...this.generateMockLogs(stage));
        }
      }
    } else {
      // Get logs for all stages
      for (const stage of run.stages) {
        const stageLogs = run.logs.get(stage.id) ?? this.generateMockLogs(stage);
        logs.push(...stageLogs);
      }
    }

    return { logs, hasMore: false };
  }

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  async listPipelines(): Promise<ListPipelinesResult> {
    const pipelines = Array.from(this.pipelines.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      folder: p.folder,
      defaultBranch: p.defaultBranch,
      parameters: p.parameters,
      webUrl: p.webUrl,
    }));

    return { pipelines };
  }

  async getPipelineHistory(input: GetPipelineHistoryInput): Promise<GetPipelineHistoryResult> {
    let runs = Array.from(this.runs.values());

    // Filter by pipeline
    if (input.pipelineId) {
      runs = runs.filter((r) => r.pipelineId === input.pipelineId);
    }

    // Filter by state
    if (input.state) {
      runs = runs.filter((r) => r.state === input.state);
    }

    // Filter by time range
    if (input.after) {
      runs = runs.filter((r) => r.queuedAt >= input.after!);
    }
    if (input.before) {
      runs = runs.filter((r) => r.queuedAt <= input.before!);
    }

    // Sort by queued time descending
    runs.sort((a, b) => b.queuedAt - a.queuedAt);

    // Apply limit
    const limit = input.limit ?? 10;
    const hasMore = runs.length > limit;
    runs = runs.slice(0, limit);

    return {
      runs: runs.map((r) => this.toPublicRun(r)),
      hasMore,
    };
  }

  // ---------------------------------------------------------------------------
  // Test Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Add a custom mock pipeline definition
   */
  addPipeline(pipeline: MockPipelineDefinition): void {
    this.pipelines.set(pipeline.id, pipeline);
  }

  /**
   * Clear all runs (useful for test cleanup)
   */
  clearRuns(): void {
    for (const run of this.runs.values()) {
      if (run.progressTimer) {
        clearTimeout(run.progressTimer);
      }
    }
    this.runs.clear();
  }

  /**
   * Get a run by ID (for testing)
   */
  getRun(runId: string): PipelineRun | undefined {
    const run = this.runs.get(runId);
    return run ? this.toPublicRun(run) : undefined;
  }

  /**
   * Force a stage to complete (for testing)
   */
  async forceStageComplete(
    runId: string,
    stageId: string,
    result: "succeeded" | "failed" = "succeeded",
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    const stage = run.stages.find((s) => s.id === stageId);
    if (!stage) return;

    stage.state = result;
    stage.finishedAt = Date.now();
    if (stage.startedAt) {
      stage.durationMs = stage.finishedAt - stage.startedAt;
    }
    stage.result = result;

    await this.emitEvent({
      type: "stage.completed",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      stageId: stage.id,
      stageName: stage.name,
      result,
    });
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private initializeDefaultPipelines(): void {
    // Create default mock pipelines
    const defaultPipelines: MockPipelineDefinition[] = [
      {
        id: "build-and-deploy",
        name: "Build and Deploy",
        description: "Build, test, and deploy application",
        defaultBranch: "main",
        stageCount: this.config.stageCount,
        approvalStages: this.config.simulateApprovalGates ? [1] : [], // Approval before stage 2 (index 1)
        webUrl: "https://mock.example.com/pipeline/build-and-deploy",
      },
      {
        id: "ci",
        name: "Continuous Integration",
        description: "Build and test pipeline",
        defaultBranch: "main",
        stageCount: 2,
        approvalStages: [],
        webUrl: "https://mock.example.com/pipeline/ci",
      },
      {
        id: "release",
        name: "Release Pipeline",
        description: "Production release with approval gates",
        defaultBranch: "main",
        stageCount: 4,
        approvalStages: this.config.simulateApprovalGates ? [1, 3] : [], // Approvals before staging and prod
        parameters: [
          { name: "version", type: "string", required: true },
          { name: "skipTests", type: "boolean", defaultValue: "false" },
        ],
        webUrl: "https://mock.example.com/pipeline/release",
      },
    ];

    for (const pipeline of defaultPipelines) {
      this.pipelines.set(pipeline.id, pipeline);
    }
  }

  private createStages(pipeline: MockPipelineDefinition): Stage[] {
    const stageNames = ["Build", "Test", "Deploy to Staging", "Deploy to Production", "Verify"];
    const stages: Stage[] = [];

    for (let i = 0; i < pipeline.stageCount; i++) {
      const stageName = stageNames[i] ?? `Stage ${i + 1}`;
      const stageId = `stage-${i}`;
      const hasApprovalGate = pipeline.approvalStages.includes(i);

      stages.push({
        id: stageId,
        name: stageName,
        displayName: stageName,
        state: "pending",
        order: i,
        hasApprovalGate,
      });
    }

    return stages;
  }

  private findRun(runId?: string, providerRunId?: string): MockPipelineRun {
    if (runId) {
      const run = this.runs.get(runId);
      if (run) return run;
    }

    if (providerRunId) {
      for (const run of this.runs.values()) {
        if (run.providerRunId === providerRunId) {
          return run;
        }
      }
    }

    throw new PipelineProviderError(
      `Pipeline run not found: runId=${runId}, providerRunId=${providerRunId}`,
      "NOT_FOUND",
      "mock",
    );
  }

  private toPublicRun(run: MockPipelineRun): PipelineRun {
    const { logs: _logs, approvals: _approvals, progressTimer: _timer, ...publicRun } = run;
    return publicRun;
  }

  private async startPipelineExecution(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    // Update state to running
    run.state = "running";
    run.startedAt = Date.now();

    // Emit started event
    await this.emitEvent({
      type: "pipeline.started",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      pipelineName: run.pipelineName,
    });

    // Start executing stages
    this.executeNextStage(runId);
  }

  private async executeNextStage(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    // Check if run is cancelled
    if (run.state === "cancelled" || run.state === "failed") {
      return;
    }

    // Find the next pending stage
    const nextStage = run.stages.find((s) => s.state === "pending");
    if (!nextStage) {
      // All stages complete - check results
      this.completePipeline(runId);
      return;
    }

    // Check if this stage has an approval gate
    if (nextStage.hasApprovalGate && !this.hasApprovalForStage(run, nextStage.id)) {
      await this.requestApproval(runId, nextStage);
      return;
    }

    // Start the stage
    await this.startStage(runId, nextStage.id);
  }

  private hasApprovalForStage(run: MockPipelineRun, stageId: string): boolean {
    for (const approval of run.approvals.values()) {
      if (approval.stageId === stageId && approval.status === "approved") {
        return true;
      }
    }
    return false;
  }

  private async requestApproval(runId: string, stage: Stage): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    const approvalId = randomUUID();
    const now = Date.now();

    const approval: ApprovalRequest = {
      id: approvalId,
      runId: run.id,
      providerRunId: run.providerRunId,
      stageId: stage.id,
      stageName: stage.name,
      pipelineName: run.pipelineName,
      status: "pending",
      requestedAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_MS,
      approvers: ["mock-approver"],
      instructions: `Please approve deployment for stage: ${stage.name}`,
    };

    // Store the approval
    run.approvals.set(approvalId, approval);

    // Update stage and run state
    stage.state = "waiting_for_approval";
    stage.approval = approval;
    run.state = "waiting_for_approval";

    // Emit event
    await this.emitEvent({
      type: "stage.waiting_for_approval",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: now,
      stageId: stage.id,
      stageName: stage.name,
      approvalId,
      approvers: approval.approvers,
      instructions: approval.instructions,
      expiresAt: approval.expiresAt,
    });
  }

  private async startStage(runId: string, stageId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    const stage = run.stages.find((s) => s.id === stageId);
    if (!stage) return;

    // Update stage state
    stage.state = "running";
    stage.startedAt = Date.now();

    // Generate initial logs
    run.logs.set(stageId, [
      { timestamp: Date.now(), line: `Starting stage: ${stage.name}`, level: "info" },
    ]);

    // Emit stage started event
    await this.emitEvent({
      type: "stage.started",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      stageId: stage.id,
      stageName: stage.name,
    });

    // Schedule stage completion
    const delay = this.config.simulatedDelayMs;
    run.progressTimer = setTimeout(() => {
      this.completeStage(runId, stageId);
    }, delay);
  }

  private async continueStageExecution(runId: string, stageId: string): Promise<void> {
    // Stage was approved, now run it
    await this.startStage(runId, stageId);
  }

  private async completeStage(runId: string, stageId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    const stage = run.stages.find((s) => s.id === stageId);
    if (!stage) return;

    // Determine if this stage should fail
    const shouldFail = Math.random() < this.config.failureProbability;
    const result: "succeeded" | "failed" = shouldFail ? "failed" : "succeeded";

    // Update stage state
    stage.state = result;
    stage.finishedAt = Date.now();
    if (stage.startedAt) {
      stage.durationMs = stage.finishedAt - stage.startedAt;
    }
    stage.result = result;

    // Add completion log
    const logs = run.logs.get(stageId) ?? [];
    logs.push({ timestamp: Date.now(), line: `Stage ${result}: ${stage.name}`, level: result === "succeeded" ? "info" : "error" });
    run.logs.set(stageId, logs);

    // Emit stage completed event
    await this.emitEvent({
      type: "stage.completed",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      stageId: stage.id,
      stageName: stage.name,
      result,
    });

    // If stage failed, fail the pipeline
    if (shouldFail) {
      run.state = "failed";
      run.finishedAt = Date.now();
      run.result = "failed";

      // Skip remaining stages
      for (const s of run.stages) {
        if (s.state === "pending") {
          s.state = "skipped";
        }
      }

      await this.emitEvent({
        type: "pipeline.completed",
        id: randomUUID(),
        runId: run.id,
        providerRunId: run.providerRunId,
        timestamp: Date.now(),
        pipelineName: run.pipelineName,
        result: "failed",
      });
      return;
    }

    // Continue to next stage
    this.executeNextStage(runId);
  }

  private async completePipeline(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    // Determine final result based on stages
    const hasFailure = run.stages.some((s) => s.state === "failed" || s.state === "rejected");
    const result: PipelineState = hasFailure ? "failed" : "succeeded";

    run.state = result;
    run.finishedAt = Date.now();
    run.result = result as "succeeded" | "failed";
    if (run.startedAt) {
      run.durationMs = run.finishedAt - run.startedAt;
    }

    // Emit pipeline completed event
    await this.emitEvent({
      type: "pipeline.completed",
      id: randomUUID(),
      runId: run.id,
      providerRunId: run.providerRunId,
      timestamp: Date.now(),
      pipelineName: run.pipelineName,
      result: result as "succeeded" | "failed",
    });
  }

  private generateMockLogs(stage: Stage): LogEntry[] {
    const logs: LogEntry[] = [];
    const baseTime = stage.startedAt ?? Date.now();

    logs.push({
      timestamp: baseTime,
      line: `=== Stage: ${stage.name} ===`,
      level: "info",
    });

    if (stage.state === "running" || stage.state === "succeeded") {
      logs.push(
        { timestamp: baseTime + 100, line: "Initializing...", level: "info" },
        { timestamp: baseTime + 200, line: "Running tasks...", level: "info" },
      );
    }

    if (stage.state === "succeeded") {
      logs.push({ timestamp: baseTime + 500, line: "Stage completed successfully", level: "info" });
    } else if (stage.state === "failed") {
      logs.push({ timestamp: baseTime + 500, line: "Stage failed with error", level: "error" });
    } else if (stage.state === "waiting_for_approval") {
      logs.push({ timestamp: baseTime + 100, line: "Waiting for approval...", level: "info" });
    }

    return logs;
  }
}
