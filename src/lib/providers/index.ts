export interface ExecutionResult {
  success: boolean;
  shouldRetry: boolean;
  budgetExceeded?: boolean;
  retryAfter?: Date;
  error?: string;
  /**
   * The provider could not authenticate (expired/revoked login, bad API key). Nothing is wrong
   * with the task, so the worker hands it to another provider rather than failing it.
   */
  authFailed?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache reads, where the provider reports them (not included in `inputTokens` for Claude). */
  cacheReadTokens?: number;
  /** Prompt-cache writes, where the provider reports them. */
  cacheCreationTokens?: number;
  /** The model that actually answered, when the provider reports it (telemetry only). */
  model?: string;
  /**
   * The model's own stop reasons over the run (`end_turn`, `tool_use`, `max_tokens`, `length`, …),
   * distinct, when the provider reports them — telemetry's `gen_ai.response.finish_reasons`.
   */
  finishReasons?: string[];
}

export interface PromptAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface PromptContent {
  system: string;
  user: string;
  attachments?: PromptAttachment[];
  /**
   * Sub-folder (relative to the workspace root) where the attachment files
   * should be copied when the agent runs. Empty / undefined means the
   * workspace root.
   */
  attachmentsFolder?: string;
}

export type MessageFetcher = () => Promise<{ id: string; content: string } | null>;
export type CancelChecker = () => Promise<boolean>;
export type TokenUpdateCallback = (inputTokens: number, outputTokens: number) => void | Promise<void>;

export interface Provider {
  /**
   * Environment overlay applied to the agent this provider spawns (or to the shell
   * commands it runs, for the API-based providers). Carries per-task tool access:
   * credentials for granted tools, stripped credentials + PATH shims for denied
   * ones. See src/lib/agent-tools.ts.
   */
  agentEnv?: AgentEnvOverlay;
  /**
   * External MCP servers (Settings → MCP Servers) handed to the agent. Only the
   * CLI-based providers (`cli`, `codex-cli`) read it. See src/lib/mcp-servers.ts.
   */
  mcp?: AgentMcpConfig;
  execute(
    taskId: string,
    prompt: PromptContent,
    onOutput: (chunk: string, level?: "info" | "error" | "system") => void,
    getNextMessage?: MessageFetcher,
    cwd?: string,
    isCancelled?: CancelChecker,
    onTokenUpdate?: TokenUpdateCallback,
  ): Promise<ExecutionResult>;
}

import type { AgentEnvOverlay } from "../agent-tools";
import type { AgentMcpConfig } from "../mcp-servers";
import { CliProvider } from "./cli";
import { ApiProvider } from "./api";
import { OpenAIProvider } from "./openai";
import { ClaudePkiProvider } from "./claude-pki";
import { CodexCliProvider } from "./codex-cli";

export { CliProvider } from "./cli";
export { ApiProvider } from "./api";
export { OpenAIProvider } from "./openai";
export { ClaudePkiProvider } from "./claude-pki";
export { CodexCliProvider } from "./codex-cli";

export function createProvider(
  type: "cli" | "api" | "openai" | "claude-pki" | "codex-cli",
  options?: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    timeoutMs?: number;
    maxTokens?: number;
    configDir?: string;
    maxOutputTokens?: number;
    pkiCert?: Buffer;
    pkiPassphrase?: string;
    proxyUrl?: string;
    // Thinking-effort override — passed as `--effort` to the Claude CLI or
    // `output_config.effort` to the Anthropic API. See src/lib/effort.ts.
    effort?: string;
    /** Per-task tool access env overlay (see src/lib/agent-tools.ts). */
    agentEnv?: AgentEnvOverlay;
    /** External MCP servers for the agent (see src/lib/mcp-servers-runtime.ts). */
    mcp?: AgentMcpConfig;
  },
): Provider {
  const provider = createProviderInstance(type, options);
  if (options?.agentEnv) provider.agentEnv = options.agentEnv;
  if (options?.mcp) provider.mcp = options.mcp;
  return provider;
}

function createProviderInstance(
  type: Parameters<typeof createProvider>[0],
  options?: Parameters<typeof createProvider>[1],
): Provider {
  if (type === "api") {
    return new ApiProvider(options?.apiKey, options?.model, options?.baseURL, options?.timeoutMs, options?.maxTokens, options?.effort);
  }
  if (type === "openai") {
    return new OpenAIProvider(options?.apiKey, options?.model, options?.baseURL, options?.timeoutMs, options?.maxTokens);
  }
  if (type === "claude-pki") {
    if (!options?.pkiCert) {
      throw new Error("claude-pki provider requires a .p12 client certificate");
    }
    return new ClaudePkiProvider(
      options.pkiCert,
      options.pkiPassphrase,
      options.apiKey,
      options.model,
      options.baseURL,
      options.proxyUrl,
      options.timeoutMs,
      options.maxTokens,
      options.effort,
    );
  }
  if (type === "codex-cli") {
    return new CodexCliProvider(options?.timeoutMs, options?.configDir, options?.model, options?.effort);
  }
  return new CliProvider(options?.timeoutMs, options?.maxTokens, options?.configDir, options?.model, options?.maxOutputTokens, options?.effort);
}
