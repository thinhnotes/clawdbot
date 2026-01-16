/**
 * Pipeline Provider Factory
 *
 * This module exports the provider factory function for creating pipeline providers
 * by name. Supports lazy provider instantiation for efficient resource usage.
 *
 * The factory pattern allows:
 * - Dynamic provider selection based on configuration
 * - Lazy loading of provider implementations
 * - Clean abstraction for the pipeline manager
 *
 * @example
 * ```typescript
 * import { createProvider } from "./providers/index.js";
 *
 * const provider = createProvider({
 *   type: "azure-devops",
 *   config: {
 *     organizationUrl: "https://dev.azure.com/myorg",
 *     project: "my-project",
 *     pat: "xxx",
 *   },
 * });
 * ```
 */

import type { ProviderName } from "../types.js";
import type {
  PipelineProvider,
  ProviderConfig,
  AzureDevOpsProviderConfig,
  GitHubActionsProviderConfig,
  GitLabCIProviderConfig,
  MockProviderConfig,
} from "./base.js";

// Re-export base module items for convenience
export { PipelineProviderError } from "./base.js";
export type { PipelineProvider, ProviderConfig } from "./base.js";
export type {
  AzureDevOpsProviderConfig,
  GitHubActionsProviderConfig,
  GitLabCIProviderConfig,
  MockProviderConfig,
  BaseProviderConfig,
} from "./base.js";

// Re-export ProviderName from types
export { ProviderNameSchema, type ProviderName } from "../types.js";

// -----------------------------------------------------------------------------
// Provider Registry
// -----------------------------------------------------------------------------

/**
 * Provider constructor signature for the registry
 */
type ProviderConstructor<T> = new (config: T) => PipelineProvider;

/**
 * Registry entry for a provider
 */
interface ProviderEntry<T = unknown> {
  /** Provider constructor or lazy loader */
  getProvider: () => Promise<ProviderConstructor<T>>;
  /** Whether the provider is loaded */
  loaded: boolean;
  /** Cached constructor after loading */
  constructor?: ProviderConstructor<T>;
}

/**
 * Internal registry of available providers.
 * Uses lazy loading to avoid importing providers until needed.
 */
const providerRegistry = new Map<ProviderName, ProviderEntry>();

/**
 * Register a provider with lazy loading support
 */
function registerProvider<T>(
  name: ProviderName,
  loader: () => Promise<ProviderConstructor<T>>,
): void {
  providerRegistry.set(name, {
    getProvider: loader as () => Promise<ProviderConstructor<unknown>>,
    loaded: false,
  });
}

/**
 * Initialize the provider registry with lazy loaders for each provider type.
 * Each loader dynamically imports the provider module when first requested.
 */
function initializeRegistry(): void {
  // Azure DevOps provider - lazy loaded
  registerProvider<AzureDevOpsProviderConfig>("azure-devops", async () => {
    const module = await import("./azure-devops.js");
    return module.AzureDevOpsProvider;
  });

  // GitHub Actions provider - lazy loaded
  registerProvider<GitHubActionsProviderConfig>("github-actions", async () => {
    const module = await import("./github-actions.js");
    return module.GitHubActionsProvider;
  });

  // GitLab CI provider - lazy loaded
  registerProvider<GitLabCIProviderConfig>("gitlab-ci", async () => {
    const module = await import("./gitlab-ci.js");
    return module.GitLabCIProvider;
  });

  // Mock provider - lazy loaded
  registerProvider<MockProviderConfig>("mock", async () => {
    const module = await import("./mock.js");
    return module.MockProvider;
  });
}

// Initialize registry on module load
initializeRegistry();

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Options for provider creation
 */
export interface CreateProviderOptions {
  /** Whether to call initialize() after creation (default: true) */
  autoInitialize?: boolean;
}

/**
 * Result of provider creation
 */
export interface CreateProviderResult {
  /** The created provider instance */
  provider: PipelineProvider;
  /** Provider name */
  name: ProviderName;
}

/**
 * Error thrown when a provider cannot be created
 */
export class ProviderFactoryError extends Error {
  constructor(
    message: string,
    public readonly providerName: ProviderName,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ProviderFactoryError";
  }
}

/**
 * Create a pipeline provider instance based on configuration.
 *
 * This factory function handles:
 * - Lazy loading of provider implementations
 * - Provider instantiation with configuration
 * - Optional auto-initialization
 *
 * @param config - Provider configuration with type discriminator
 * @param options - Optional creation options
 * @returns Promise resolving to the created provider
 * @throws ProviderFactoryError if provider cannot be created
 *
 * @example
 * ```typescript
 * // Create an Azure DevOps provider
 * const provider = await createProvider({
 *   type: "azure-devops",
 *   config: {
 *     organizationUrl: "https://dev.azure.com/myorg",
 *     project: "my-project",
 *     pat: process.env.AZURE_DEVOPS_PAT!,
 *   },
 * });
 *
 * // Create a mock provider for testing
 * const mockProvider = await createProvider({
 *   type: "mock",
 *   config: {
 *     stageCount: 3,
 *     simulateApprovalGates: true,
 *   },
 * });
 * ```
 */
export async function createProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): Promise<PipelineProvider> {
  const { autoInitialize = true } = options;
  const providerName = config.type;

  // Get the registry entry for this provider
  const entry = providerRegistry.get(providerName);
  if (!entry) {
    throw new ProviderFactoryError(
      `Unknown provider: ${providerName}. Available providers: ${getAvailableProviders().join(", ")}`,
      providerName,
    );
  }

  try {
    // Lazy load the provider constructor if not already loaded
    let ProviderClass = entry.constructor;
    if (!ProviderClass) {
      ProviderClass = await entry.getProvider();
      entry.constructor = ProviderClass;
      entry.loaded = true;
    }

    // Create the provider instance
    const provider = new ProviderClass(config.config);

    // Optionally initialize the provider
    if (autoInitialize && provider.initialize) {
      await provider.initialize();
    }

    return provider;
  } catch (error) {
    // Handle module not found errors specially
    if (isModuleNotFoundError(error)) {
      throw new ProviderFactoryError(
        `Provider '${providerName}' is not implemented yet. ` +
          `Please check that the provider module exists at ./providers/${providerName}.ts`,
        providerName,
        error as Error,
      );
    }

    // Re-throw factory errors as-is
    if (error instanceof ProviderFactoryError) {
      throw error;
    }

    // Wrap other errors
    throw new ProviderFactoryError(
      `Failed to create provider '${providerName}': ${error instanceof Error ? error.message : String(error)}`,
      providerName,
      error as Error,
    );
  }
}

/**
 * Check if a provider is available (registered in the registry).
 *
 * @param name - Provider name to check
 * @returns true if the provider is registered
 */
export function isProviderAvailable(name: ProviderName): boolean {
  return providerRegistry.has(name);
}

/**
 * Get a list of all registered provider names.
 *
 * @returns Array of available provider names
 */
export function getAvailableProviders(): ProviderName[] {
  return Array.from(providerRegistry.keys());
}

/**
 * Check if a provider has been loaded (its module has been imported).
 *
 * @param name - Provider name to check
 * @returns true if the provider module has been loaded
 */
export function isProviderLoaded(name: ProviderName): boolean {
  const entry = providerRegistry.get(name);
  return entry?.loaded ?? false;
}

/**
 * Preload a provider module without creating an instance.
 * Useful for warming up providers before they're needed.
 *
 * @param name - Provider name to preload
 * @throws ProviderFactoryError if provider cannot be loaded
 */
export async function preloadProvider(name: ProviderName): Promise<void> {
  const entry = providerRegistry.get(name);
  if (!entry) {
    throw new ProviderFactoryError(
      `Unknown provider: ${name}`,
      name,
    );
  }

  if (!entry.loaded) {
    try {
      entry.constructor = await entry.getProvider();
      entry.loaded = true;
    } catch (error) {
      throw new ProviderFactoryError(
        `Failed to preload provider '${name}': ${error instanceof Error ? error.message : String(error)}`,
        name,
        error as Error,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Check if an error is a module not found error
 */
function isModuleNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    // Node.js ESM module not found
    if (error.message.includes("Cannot find module")) {
      return true;
    }
    // Dynamic import error
    if (error.message.includes("Failed to load")) {
      return true;
    }
    // ERR_MODULE_NOT_FOUND code
    if ("code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Provider Type Guards
// -----------------------------------------------------------------------------

/**
 * Type guard to check if a config is for Azure DevOps
 */
export function isAzureDevOpsConfig(
  config: ProviderConfig,
): config is { type: "azure-devops"; config: AzureDevOpsProviderConfig } {
  return config.type === "azure-devops";
}

/**
 * Type guard to check if a config is for GitHub Actions
 */
export function isGitHubActionsConfig(
  config: ProviderConfig,
): config is { type: "github-actions"; config: GitHubActionsProviderConfig } {
  return config.type === "github-actions";
}

/**
 * Type guard to check if a config is for GitLab CI
 */
export function isGitLabCIConfig(
  config: ProviderConfig,
): config is { type: "gitlab-ci"; config: GitLabCIProviderConfig } {
  return config.type === "gitlab-ci";
}

/**
 * Type guard to check if a config is for Mock provider
 */
export function isMockConfig(
  config: ProviderConfig,
): config is { type: "mock"; config: MockProviderConfig } {
  return config.type === "mock";
}
