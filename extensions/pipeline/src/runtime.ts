/**
 * Pipeline Runtime
 *
 * Runtime initialization and lifecycle management for the pipeline plugin.
 * Creates and initializes all components based on configuration, wires them
 * together, and provides graceful shutdown handling.
 *
 * Features:
 * - Provider initialization based on configuration
 * - Notification hub setup with enabled channels
 * - Optional webhook server for real-time updates
 * - Graceful shutdown with resource cleanup
 * - Lifecycle event emission
 *
 * @example
 * ```typescript
 * import { createPipelineRuntime, PipelineRuntime } from "./runtime.js";
 *
 * // Create runtime from configuration
 * const runtime = await createPipelineRuntime({
 *   enabled: true,
 *   provider: "azure-devops",
 *   azureDevops: {
 *     organization: "myorg",
 *     project: "myproject",
 *     pat: "xxx",
 *   },
 *   notifications: {
 *     discord: { enabled: true, webhookUrl: "..." },
 *     slack: { enabled: false },
 *     telegram: { enabled: false },
 *     macos: { enabled: true },
 *   },
 * });
 *
 * // Access the pipeline manager
 * const run = await runtime.manager.triggerPipeline({ pipelineId: "build" });
 *
 * // Graceful shutdown
 * await runtime.dispose();
 * ```
 */

import type { Server } from "node:http";

import type { PipelineConfig } from "./config.js";
import { validateConfig } from "./config.js";
import type { PipelineProvider } from "./providers/base.js";
import { createProvider, type ProviderConfig } from "./providers/index.js";
import { createStateMachine, type PipelineStateMachine } from "./engine/state-machine.js";
import { createStore, type PipelineStore } from "./engine/store.js";
import { createApprovalQueue, type ApprovalQueue } from "./engine/approval.js";
import { createApprovalHandler, type ApprovalHandler } from "./engine/approval-handler.js";
import { createNotificationHub, type NotificationHub } from "./notifications/hub.js";
import {
  createChannelsFromConfig,
  type NotificationChannel,
} from "./notifications/channels/index.js";
import {
  createPipelineManager,
  type PipelineManager,
  type PipelineManagerConfig,
} from "./manager.js";
import type { ProviderName } from "./types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Options for creating the pipeline runtime
 */
export interface CreateRuntimeOptions {
  /** Override auto-initialization (default: true) */
  autoInitialize?: boolean;
  /** Override webhook server creation (default: follows config) */
  createWebhookServer?: boolean;
  /** Custom logger function */
  logger?: RuntimeLogger;
}

/**
 * Logger interface for runtime events
 */
export interface RuntimeLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

/**
 * Runtime status information
 */
export interface RuntimeStatus {
  /** Whether the runtime is initialized and running */
  initialized: boolean;
  /** Active provider name */
  provider: ProviderName | undefined;
  /** Enabled notification channels */
  enabledChannels: string[];
  /** Whether webhook server is running */
  webhookServerRunning: boolean;
  /** Number of active pipeline runs */
  activeRuns: number;
  /** Number of pending approvals */
  pendingApprovals: number;
}

/**
 * Runtime event types
 */
export type RuntimeEventMap = {
  /** Emitted when runtime is initializing */
  "runtime.initializing": { config: PipelineConfig };
  /** Emitted when runtime is initialized */
  "runtime.initialized": { status: RuntimeStatus };
  /** Emitted when runtime is disposing */
  "runtime.disposing": Record<string, never>;
  /** Emitted when runtime is disposed */
  "runtime.disposed": Record<string, never>;
  /** Emitted on runtime error */
  "runtime.error": { error: Error; context: string };
};

export type RuntimeEventHandler<K extends keyof RuntimeEventMap> = (
  event: RuntimeEventMap[K]
) => void | Promise<void>;

/**
 * Components created during runtime initialization
 */
export interface RuntimeComponents {
  /** Pipeline provider instance */
  provider: PipelineProvider;
  /** State machine for tracking execution */
  stateMachine: PipelineStateMachine;
  /** Store for persistence */
  store?: PipelineStore;
  /** Approval queue for pending approvals */
  approvalQueue: ApprovalQueue;
  /** Approval handler for processing decisions */
  approvalHandler: ApprovalHandler;
  /** Notification hub for alerts */
  notificationHub: NotificationHub;
  /** Notification channels */
  notificationChannels: NotificationChannel[];
  /** Webhook server (if enabled) */
  webhookServer?: Server;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WEBHOOK_PORT = 3335;
const DEFAULT_WEBHOOK_PATH = "/pipeline/webhook";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown by runtime operations
 */
export class PipelineRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONFIG_INVALID"
      | "PROVIDER_INIT_FAILED"
      | "COMPONENT_INIT_FAILED"
      | "WEBHOOK_SERVER_FAILED"
      | "NOT_INITIALIZED"
      | "ALREADY_INITIALIZED"
      | "DISPOSE_FAILED"
  ) {
    super(message);
    this.name = "PipelineRuntimeError";
  }
}

// -----------------------------------------------------------------------------
// PipelineRuntime Implementation
// -----------------------------------------------------------------------------

/**
 * Pipeline runtime for managing the full lifecycle of the pipeline plugin.
 *
 * Provides:
 * - Component initialization and wiring
 * - Lifecycle management (initialize, dispose)
 * - Access to all pipeline components
 * - Status information
 */
export class PipelineRuntime {
  private readonly config: PipelineConfig;
  private readonly options: Required<CreateRuntimeOptions>;
  private readonly eventHandlers: Map<
    keyof RuntimeEventMap,
    Set<RuntimeEventHandler<keyof RuntimeEventMap>>
  > = new Map();

  private _components?: RuntimeComponents;
  private _manager?: PipelineManager;
  private initialized = false;
  private disposing = false;

  constructor(config: PipelineConfig, options?: CreateRuntimeOptions) {
    this.config = config;
    this.options = {
      autoInitialize: options?.autoInitialize ?? true,
      createWebhookServer: options?.createWebhookServer ?? config.webhook?.enabled ?? false,
      logger: options?.logger ?? {},
    };
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get the pipeline manager instance
   * @throws PipelineRuntimeError if not initialized
   */
  get manager(): PipelineManager {
    this.ensureInitialized();
    return this._manager!;
  }

  /**
   * Get the runtime components
   * @throws PipelineRuntimeError if not initialized
   */
  get components(): RuntimeComponents {
    this.ensureInitialized();
    return this._components!;
  }

  /**
   * Get the provider instance
   * @throws PipelineRuntimeError if not initialized
   */
  get provider(): PipelineProvider {
    return this.components.provider;
  }

  /**
   * Get the notification hub
   * @throws PipelineRuntimeError if not initialized
   */
  get notificationHub(): NotificationHub {
    return this.components.notificationHub;
  }

  /**
   * Get the approval queue
   * @throws PipelineRuntimeError if not initialized
   */
  get approvalQueue(): ApprovalQueue {
    return this.components.approvalQueue;
  }

  /**
   * Get the state machine
   * @throws PipelineRuntimeError if not initialized
   */
  get stateMachine(): PipelineStateMachine {
    return this.components.stateMachine;
  }

  /**
   * Get the store (if available)
   */
  get store(): PipelineStore | undefined {
    return this._components?.store;
  }

  /**
   * Get the configuration
   */
  getConfig(): PipelineConfig {
    return this.config;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the runtime and all components
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new PipelineRuntimeError(
        "Runtime is already initialized",
        "ALREADY_INITIALIZED"
      );
    }

    this.log("info", "Initializing pipeline runtime", { provider: this.config.provider });

    // Emit initializing event
    await this.emit("runtime.initializing", { config: this.config });

    try {
      // 1. Validate configuration
      const validation = validateConfig(this.config);
      if (!validation.valid) {
        throw new PipelineRuntimeError(
          `Invalid configuration: ${validation.errors.join(", ")}`,
          "CONFIG_INVALID"
        );
      }

      // 2. Create components
      this._components = await this.createComponents();

      // 3. Initialize components
      await this.initializeComponents(this._components);

      // 4. Create pipeline manager
      this._manager = await this.createManager(this._components);

      // 5. Set up webhook server if enabled
      if (this.options.createWebhookServer && this.config.webhook?.enabled) {
        await this.setupWebhookServer();
      }

      this.initialized = true;

      // Get status for event
      const status = await this.getStatus();
      await this.emit("runtime.initialized", { status });

      this.log("info", "Pipeline runtime initialized", {
        provider: this.config.provider,
        channels: status.enabledChannels,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log("error", "Failed to initialize runtime", { error: err.message });
      await this.emit("runtime.error", { error: err, context: "initialize" });
      throw error;
    }
  }

  /**
   * Check if the runtime is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose the runtime and clean up all resources
   */
  async dispose(): Promise<void> {
    if (!this.initialized || this.disposing) {
      return;
    }

    this.disposing = true;
    this.log("info", "Disposing pipeline runtime");
    await this.emit("runtime.disposing", {});

    const errors: Error[] = [];

    try {
      // 1. Stop webhook server
      if (this._components?.webhookServer) {
        try {
          await this.closeWebhookServer(this._components.webhookServer);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      // 2. Dispose manager (stops polling, clears event handlers)
      if (this._manager) {
        try {
          await this._manager.dispose();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      // 3. Dispose components in reverse order of creation
      if (this._components) {
        // Dispose notification channels
        for (const channel of this._components.notificationChannels) {
          try {
            if (channel.dispose) {
              await channel.dispose();
            }
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }

        // Dispose notification hub
        try {
          await this._components.notificationHub.dispose();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }

        // Dispose approval handler
        try {
          await this._components.approvalHandler.dispose();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }

        // Dispose approval queue
        try {
          await this._components.approvalQueue.dispose();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }

        // Dispose store
        if (this._components.store) {
          try {
            await this._components.store.dispose();
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }

        // Dispose provider
        if (this._components.provider.dispose) {
          try {
            await this._components.provider.dispose();
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }

      this._components = undefined;
      this._manager = undefined;
      this.initialized = false;
      this.disposing = false;
      this.eventHandlers.clear();

      await this.emit("runtime.disposed", {});
      this.log("info", "Pipeline runtime disposed");

      // Report any errors that occurred during disposal
      if (errors.length > 0) {
        const combinedMessage = errors.map((e) => e.message).join("; ");
        throw new PipelineRuntimeError(
          `Errors during disposal: ${combinedMessage}`,
          "DISPOSE_FAILED"
        );
      }
    } catch (error) {
      this.disposing = false;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Get the current runtime status
   */
  async getStatus(): Promise<RuntimeStatus> {
    if (!this.initialized || !this._components || !this._manager) {
      return {
        initialized: false,
        provider: undefined,
        enabledChannels: [],
        webhookServerRunning: false,
        activeRuns: 0,
        pendingApprovals: 0,
      };
    }

    const managerStats = await this._manager.getStats();
    const enabledChannels = this._components.notificationHub
      .getEnabledChannels()
      .map((c) => c.type);

    return {
      initialized: true,
      provider: this.config.provider,
      enabledChannels,
      webhookServerRunning: this._components.webhookServer?.listening ?? false,
      activeRuns: managerStats.activeRuns,
      pendingApprovals: managerStats.pendingApprovals,
    };
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to runtime events
   *
   * @param event - Event type to subscribe to
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof RuntimeEventMap>(
    event: K,
    handler: RuntimeEventHandler<K>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as RuntimeEventHandler<keyof RuntimeEventMap>);

    return () => {
      handlers?.delete(handler as RuntimeEventHandler<keyof RuntimeEventMap>);
    };
  }

  /**
   * Remove event handlers
   */
  off<K extends keyof RuntimeEventMap>(event?: K): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  private async emit<K extends keyof RuntimeEventMap>(
    event: K,
    payload: RuntimeEventMap[K]
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await (handler as RuntimeEventHandler<K>)(payload);
      } catch {
        // Ignore handler errors
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Component Creation
  // ---------------------------------------------------------------------------

  /**
   * Create all runtime components
   */
  private async createComponents(): Promise<RuntimeComponents> {
    // 1. Create provider
    const provider = await this.createProvider();

    // 2. Create state machine
    const stateMachine = createStateMachine();

    // 3. Create store (if configured)
    const store = this.createStore();

    // 4. Create notification hub and channels
    const notificationHub = createNotificationHub({
      enabledTypes: this.config.notifications?.enabledTypes,
      suppressedTypes: this.config.notifications?.suppressedTypes,
      onlyOnFailure: this.config.notifications?.onlyOnFailure,
      includeStageNotifications: this.config.notifications?.includeStageNotifications,
    });

    const notificationChannels = createChannelsFromConfig(this.config.notifications ?? {});

    // Register channels with hub
    for (const channel of notificationChannels) {
      notificationHub.registerChannel(channel.type, channel);
    }

    // 5. Create approval queue
    const approvalQueue = createApprovalQueue({
      defaultTimeoutMs: this.config.approval?.defaultTimeoutMs,
      authorizedApprovers: this.config.approval?.authorizedApprovers,
      requireRejectComment: this.config.approval?.requireRejectComment,
      autoRejectOnTimeout: this.config.approval?.autoRejectOnTimeout,
    });

    // Wire notification hub to approval queue
    approvalQueue.setNotificationHub(notificationHub);

    // 6. Create approval handler
    const approvalHandler = createApprovalHandler(
      {
        approvalQueue,
        stateMachine,
        store,
        getProvider: () => provider,
      }
    );

    return {
      provider,
      stateMachine,
      store,
      approvalQueue,
      approvalHandler,
      notificationHub,
      notificationChannels,
    };
  }

  /**
   * Create the pipeline provider based on configuration
   */
  private async createProvider(): Promise<PipelineProvider> {
    if (!this.config.provider) {
      throw new PipelineRuntimeError(
        "Provider is required when pipeline is enabled",
        "CONFIG_INVALID"
      );
    }

    try {
      const providerConfig = this.getProviderConfig();
      return await createProvider(providerConfig, { autoInitialize: false });
    } catch (error) {
      throw new PipelineRuntimeError(
        `Failed to create provider: ${error instanceof Error ? error.message : String(error)}`,
        "PROVIDER_INIT_FAILED"
      );
    }
  }

  /**
   * Get provider-specific configuration
   */
  private getProviderConfig(): ProviderConfig {
    switch (this.config.provider) {
      case "azure-devops":
        return {
          type: "azure-devops",
          config: {
            organization: this.config.azureDevops?.organization ?? "",
            project: this.config.azureDevops?.project ?? "",
            pat: this.config.azureDevops?.pat ?? "",
            apiVersion: this.config.azureDevops?.apiVersion,
            baseUrl: this.config.azureDevops?.baseUrl,
          },
        };

      case "github-actions":
        return {
          type: "github-actions",
          config: {
            owner: this.config.githubActions?.owner ?? "",
            repo: this.config.githubActions?.repo ?? "",
            token: this.config.githubActions?.token ?? "",
            baseUrl: this.config.githubActions?.baseUrl,
          },
        };

      case "gitlab-ci":
        return {
          type: "gitlab-ci",
          config: {
            projectId: this.config.gitlabCi?.projectId ?? "",
            token: this.config.gitlabCi?.token ?? "",
            baseUrl: this.config.gitlabCi?.baseUrl,
          },
        };

      case "mock":
        return {
          type: "mock",
          config: {
            stageCount: this.config.mock?.stageCount,
            simulateApprovalGates: this.config.mock?.approvalStages !== undefined &&
              this.config.mock.approvalStages.length > 0,
            simulatedDelayMs: this.config.mock?.delayRange?.[0],
            failureProbability: this.config.mock?.failureRate,
          },
        };

      default:
        throw new PipelineRuntimeError(
          `Unknown provider: ${this.config.provider}`,
          "CONFIG_INVALID"
        );
    }
  }

  /**
   * Create the pipeline store if configured
   */
  private createStore(): PipelineStore | undefined {
    if (!this.config.store || this.config.store.type === "memory") {
      // Default to memory store (which is just the state machine)
      // Return undefined to signal no separate store
      return undefined;
    }

    return createStore({
      type: this.config.store.type,
      filePath: this.config.store.filePath,
      maxHistorySize: this.config.store.maxHistorySize,
      maxHistoryAgeMs: this.config.store.maxHistoryAgeMs,
    });
  }

  /**
   * Initialize all components
   */
  private async initializeComponents(components: RuntimeComponents): Promise<void> {
    try {
      // Initialize provider
      if (components.provider.initialize) {
        await components.provider.initialize();
      }

      // Initialize store
      if (components.store) {
        await components.store.initialize();
      }

      // Initialize notification channels
      for (const channel of components.notificationChannels) {
        if (channel.initialize) {
          await channel.initialize();
        }
      }

      // Initialize notification hub
      await components.notificationHub.initialize();

      // Initialize approval queue
      await components.approvalQueue.initialize();

      // Initialize approval handler
      await components.approvalHandler.initialize();
    } catch (error) {
      throw new PipelineRuntimeError(
        `Failed to initialize components: ${error instanceof Error ? error.message : String(error)}`,
        "COMPONENT_INIT_FAILED"
      );
    }
  }

  /**
   * Create and initialize the pipeline manager
   */
  private async createManager(components: RuntimeComponents): Promise<PipelineManager> {
    const managerConfig: PipelineManagerConfig = {
      polling: this.config.polling,
      defaultPipeline: this.config.defaultPipeline,
      defaultBranch: this.config.defaultBranch,
      autoStartPolling: this.config.polling?.enabled ?? true,
    };

    const manager = createPipelineManager(
      {
        provider: components.provider,
        stateMachine: components.stateMachine,
        store: components.store,
        approvalQueue: components.approvalQueue,
        approvalHandler: components.approvalHandler,
        notificationHub: components.notificationHub,
      },
      managerConfig
    );

    await manager.initialize();
    return manager;
  }

  // ---------------------------------------------------------------------------
  // Webhook Server
  // ---------------------------------------------------------------------------

  /**
   * Set up the webhook server for receiving provider events
   */
  private async setupWebhookServer(): Promise<void> {
    if (!this._components) {
      return;
    }

    const { createServer } = await import("node:http");
    const port = this.config.webhook?.port ?? DEFAULT_WEBHOOK_PORT;
    const path = this.config.webhook?.path ?? DEFAULT_WEBHOOK_PATH;
    const bind = this.config.webhook?.bind ?? "127.0.0.1";

    return new Promise<void>((resolve, reject) => {
      const server = createServer(async (req, res) => {
        // Only handle the webhook path
        if (req.url !== path || req.method !== "POST") {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        try {
          // Read request body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString("utf-8");

          // Get headers for verification
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value[0];
            }
          }

          // Verify webhook if secret is configured
          const secret = this.config.webhook?.secret;
          if (secret && this._components?.provider.verifyWebhook) {
            const isValid = await this._components.provider.verifyWebhook({
              headers,
              body,
              secret,
            });

            if (!isValid) {
              res.writeHead(401);
              res.end("Unauthorized");
              return;
            }
          }

          // Parse webhook event
          if (this._components?.provider.parseWebhookEvent) {
            const event = await this._components.provider.parseWebhookEvent({
              headers,
              body,
            });

            // Handle the event (update state machine, etc.)
            // This would be implemented based on the event type
            this.log("debug", "Received webhook event", { type: event.type });
          }

          res.writeHead(200);
          res.end("OK");
        } catch (error) {
          this.log("error", "Webhook error", {
            error: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });

      server.on("error", (error) => {
        reject(
          new PipelineRuntimeError(
            `Webhook server error: ${error.message}`,
            "WEBHOOK_SERVER_FAILED"
          )
        );
      });

      server.listen(port, bind, () => {
        this.log("info", "Webhook server started", { port, path, bind });
        if (this._components) {
          this._components.webhookServer = server;
        }
        resolve();
      });
    });
  }

  /**
   * Close the webhook server
   */
  private closeWebhookServer(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.log("info", "Webhook server stopped");
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new PipelineRuntimeError(
        "Runtime not initialized. Call initialize() first.",
        "NOT_INITIALIZED"
      );
    }
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>
  ): void {
    const logger = this.options.logger;
    const logFn = logger[level];
    if (logFn) {
      logFn(message, data);
    }
  }
}

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------

/**
 * Create a new pipeline runtime instance
 *
 * @param config - Pipeline configuration
 * @param options - Optional runtime options
 * @returns Uninitialized runtime instance (call initialize() before use)
 */
export function createRuntime(
  config: PipelineConfig,
  options?: CreateRuntimeOptions
): PipelineRuntime {
  return new PipelineRuntime(config, options);
}

/**
 * Create and initialize a pipeline runtime
 *
 * @param config - Pipeline configuration
 * @param options - Optional runtime options
 * @returns Initialized runtime instance ready to use
 */
export async function createPipelineRuntime(
  config: PipelineConfig,
  options?: CreateRuntimeOptions
): Promise<PipelineRuntime> {
  const runtime = createRuntime(config, { ...options, autoInitialize: false });
  await runtime.initialize();
  return runtime;
}

/**
 * Create a runtime for testing with mock provider
 *
 * @param overrides - Configuration overrides
 * @returns Initialized runtime with mock provider
 */
export async function createTestRuntime(
  overrides?: Partial<PipelineConfig>
): Promise<PipelineRuntime> {
  const config: PipelineConfig = {
    enabled: true,
    provider: "mock",
    mock: {
      stageCount: 3,
      approvalStages: [1],
      delayRange: [100, 500],
      failureRate: 0,
    },
    notifications: {
      discord: { enabled: false },
      slack: { enabled: false },
      telegram: { enabled: false },
      macos: { enabled: false },
      suppressedTypes: [],
      onlyOnFailure: false,
      includeStageNotifications: true,
    },
    webhook: { enabled: false, port: 3335, bind: "127.0.0.1", path: "/pipeline/webhook" },
    polling: { enabled: true, intervalMs: 1000, fastIntervalMs: 500, maxDurationMs: 60000 },
    store: { type: "memory", maxHistorySize: 100, maxHistoryAgeMs: 3600000 },
    approval: {
      defaultTimeoutMs: 60000,
      authorizedApprovers: [],
      requireRejectComment: false,
      autoRejectOnTimeout: false,
    },
    ...overrides,
  };

  return createPipelineRuntime(config, { createWebhookServer: false });
}
