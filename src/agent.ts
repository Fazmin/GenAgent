/**
 * Gen Agent Core
 *
 * 5 core subsystems:
 * 1. Session Manager - session management (JSONL persistence)
 * 2. Memory Manager - long-term memory (keyword search)
 * 3. Context Loader - on-demand context loading (AGENTS/SOUL/TOOLS/IDENTITY/USER/HEARTBEAT/BOOTSTRAP/MEMORY)
 * 4. Skill Manager - extensible skill system
 * 5. Heartbeat Manager - proactive activation mechanism
 *
 * Core loop (agent-loop.ts):
 *   OUTER LOOP (follow-ups)
 *   ├─ INNER LOOP (tools + steering)
 *   │  ├─ Inject pendingMessages (steering or follow-up)
 *   │  ├─ LLM streaming call
 *   │  ├─ Execute tools (check steering after each execution)
 *   │  ├─ If steering: skip remaining tools
 *   │  └─ Loop condition: hasMoreToolCalls || pendingMessages.length > 0
 *   ├─ Check follow-up messages
 *   └─ If follow-up exists: continue outer loop
 */

import crypto from "node:crypto";
import type { Tool, ToolContext } from "./tools/types.js";
import { builtinTools } from "./tools/builtin.js";
import { wrapToolWithAbortSignal } from "./tools/abort.js";
import { SessionManager, type Message } from "./session.js";
import { MemoryManager, type MemorySearchResult } from "./memory.js";
import {
  ContextLoader,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  compactHistoryIfNeeded,
  estimateMessagesTokens,
  type PruneResult,
  type SummarizeFn,
} from "./context/index.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";
import { SkillManager, type SkillMatch } from "./skills.js";
import { HeartbeatManager, type HeartbeatResult } from "./heartbeat.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  resolveSessionKey,
  isSubagentSessionKey,
} from "./session-key.js";
import { enqueueInLane, resolveGlobalLane, resolveSessionLane, setLaneConcurrency } from "./command-queue.js";
import { filterToolsByPolicy, type ToolPolicy } from "./tool-policy.js";
import type { MiniAgentEvent } from "./agent-events.js";
import { runAgentLoop } from "./agent-loop.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { Model, StreamFunction } from "@mariozechner/pi-ai";
import { streamSimple, completeSimple, getModel, getEnvApiKey } from "@mariozechner/pi-ai";

// ============== Type definitions ==============

export interface AgentConfig {
  /** API Key (if not specified, auto-detected from environment variables via pi-ai getEnvApiKey) */
  apiKey?: string;
  /**
   * Provider name
   *
   * Corresponds to pi-ai KnownProvider, e.g. "anthropic" | "openai" | "google" | "groq" etc.
   * Default: "anthropic"
   */
  provider?: string;
  /** Model ID (must match provider, e.g. "claude-sonnet-4-20250514" / "gpt-4.1" / "gemini-2.5-pro") */
  model?: string;
  /**
   * Provider streaming call function
   *
   * Based on pi-agent-core → Agent.streamFn
   * - If not specified, defaults to pi-ai's streamSimple (auto-routes to the corresponding provider)
   * - Can be replaced with any custom StreamFunction
   */
  streamFn?: StreamFunction;
  /**
   * Model definition
   *
   * Based on pi-ai → Model<TApi>
   * - If not specified, obtained via getModel(provider, modelId)
   */
  modelDef?: Model<any>;
  /** Agent ID (default: main) */
  agentId?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Tool list */
  tools?: Tool[];
  /** Tool policy (allow/deny) */
  toolPolicy?: ToolPolicy;
  /** Sandbox settings (simplified version, controls tool availability only) */
  sandbox?: {
    enabled?: boolean;
    allowExec?: boolean;
    allowWrite?: boolean;
  };
  /** Temperature parameter (0-1) */
  temperature?: number;
  /** Maximum loop turns */
  maxTurns?: number;
  /** Session storage directory */
  sessionDir?: string;
  /** Working directory */
  workspaceDir?: string;
  /** Memory storage directory */
  memoryDir?: string;
  /** Whether to enable memory */
  enableMemory?: boolean;
  /** Whether to enable context loading */
  enableContext?: boolean;
  /** Whether to enable skills */
  enableSkills?: boolean;
  /** Whether to enable proactive activation */
  enableHeartbeat?: boolean;
  /** Heartbeat check interval (milliseconds) */
  heartbeatInterval?: number;
  /** Context window size (token estimate) */
  contextTokens?: number;
  /**
   * Global lane max concurrency (total parallelism across sessions)
   *
   * Based on gateway/server-lanes.ts → resolveAgentMaxConcurrent()
   * - session lane fixed at maxConcurrent=1 (serial within same session)
   * - global lane controls how many different sessions can run simultaneously (default: 2)
   */
  maxConcurrentRuns?: number;
}

export interface RunResult {
  /** Run ID for this execution */
  runId?: string;
  /** Final text output */
  text: string;
  /** Total turns */
  turns: number;
  /** Number of tool calls */
  toolCalls: number;
  /** Whether a skill was triggered */
  skillTriggered?: string;
  /** Number of memory search results (entries returned by memory_search) */
  memoriesUsed?: number;
}

// ============== Default system prompt ==============

const DEFAULT_SYSTEM_PROMPT = `You are a programming assistant Agent.

## Available Tools
- read: Read file contents
- write: Write files
- edit: Edit files (string replacement)
- exec: Execute shell commands
- list: List directory contents
- grep: Search file contents

## Principles
1. Always read a file before modifying it
2. Use edit for small-scope changes
3. Be concise, do not over-explain
4. Analyze errors and retry when they occur

## Output Format
- Concise language
- Use markdown formatting for code`;

// ============== Default model resolution ==============

/**
 * Default model IDs per provider.
 * Used when no --model flag is specified.
 */
const DEFAULT_MODEL_IDS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  google: "gemini-2.5-pro",
  groq: "llama-3.3-70b-versatile",
};

function resolveDefaultModelId(provider: string): string | undefined {
  return DEFAULT_MODEL_IDS[provider];
}

// ============== Agent core class ==============

export class Agent {
  /**
   * Provider streaming call function
   *
   * Based on pi-agent-core/agent.d.ts → Agent.streamFn
   * - Can be replaced at runtime (e.g. failover provider switch)
   */
  streamFn: StreamFunction;
  private modelDef: Model<any>;
  private apiKey?: string;
  private temperature?: number;
  private agentId: string;
  private baseSystemPrompt: string;
  private tools: Tool[];
  private maxTurns: number;
  private workspaceDir: string;
  private toolPolicy?: ToolPolicy;
  private contextTokens: number;
  private sandbox?: {
    enabled: boolean;
    allowExec: boolean;
    allowWrite: boolean;
  };

  // 5 core subsystems
  private sessions: SessionManager;
  private memory: MemoryManager;
  private context: ContextLoader;
  private skills: SkillManager;
  private heartbeat: HeartbeatManager;

  // Feature flags
  private enableMemory: boolean;
  private enableContext: boolean;
  private enableSkills: boolean;
  private enableHeartbeat: boolean;

  /**
   * Running AbortController map (runId → controller)
   *
   * Based on pi-embedded-runner/run/attempt.ts
   * - Each run() creates a runAbortController
   * - abort() can cancel a specific or all running instances from outside
   */
  private runAbortControllers = new Map<string, AbortController>();

  /**
   * Steering message queue (sessionKey → messages[])
   *
   * Based on pi-agent-core → Agent.steeringQueue
   * - Messages sent by user during tool execution are enqueued
   * - Checked after each tool execution; if non-empty, remaining tools are skipped
   * - Queued messages are processed as the next user turn
   */
  private steeringQueues = new Map<string, string[]>();

  /**
   * Tool Result Guard
   *
   * Based on session-tool-result-guard-wrapper.ts → guardSessionManager()
   * - Tracks pending tool_use, auto-synthesizes missing tool_result
   * - Prevents LLM API rejections due to unmatched tool_use/tool_result pairs
   */
  private toolResultGuard: ReturnType<typeof installSessionToolResultGuard>;

  /**
   * Event subscribers
   *
   * Based on pi-agent-core/agent.js → Agent.listeners: Set<fn>
   * - subscribe() adds a listener, returns an unsubscribe function
   * - emit() iterates listeners and calls them synchronously
   */
  private listeners = new Set<(event: MiniAgentEvent) => void>();

  constructor(config: AgentConfig) {
    // Provider initialization (based on attempt.ts → activeSession.agent.streamFn)
    const provider = config.provider ?? "anthropic";
    const modelId = config.model ?? resolveDefaultModelId(provider);
    this.modelDef = config.modelDef ?? getModel(provider as any, modelId as any);
    if (!this.modelDef) {
      throw new Error(
        `Could not resolve model for provider "${provider}"${modelId ? ` with model "${modelId}"` : ""}. ` +
        `Please specify a valid model using --model flag (e.g. --model gpt-4o for openai).`,
      );
    }
    this.streamFn = config.streamFn ?? streamSimple;
    this.agentId = normalizeAgentId(config.agentId ?? "main");
    this.baseSystemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.tools = config.tools ?? builtinTools;
    this.maxTurns = config.maxTurns ?? 20;
    this.workspaceDir = config.workspaceDir ?? process.cwd();
    this.apiKey = config.apiKey ?? getEnvApiKey(provider);
    this.temperature = config.temperature;
    this.toolPolicy = config.toolPolicy;
    this.contextTokens = Math.max(
      1,
      Math.floor(config.contextTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
    );
    this.sandbox = {
      enabled: config.sandbox?.enabled ?? false,
      allowExec: config.sandbox?.allowExec ?? false,
      allowWrite: config.sandbox?.allowWrite ?? true,
    };

    // Initialize subsystems
    this.sessions = new SessionManager(config.sessionDir);
    this.memory = new MemoryManager(config.memoryDir ?? "./.gen-agent/memory");
    this.context = new ContextLoader(this.workspaceDir);
    this.skills = new SkillManager(this.workspaceDir);
    this.heartbeat = new HeartbeatManager(this.workspaceDir, {
      intervalMs: config.heartbeatInterval,
    });

    // Feature flags
    this.enableMemory = config.enableMemory ?? true;
    this.enableContext = config.enableContext ?? true;
    this.enableSkills = config.enableSkills ?? true;
    this.enableHeartbeat = config.enableHeartbeat ?? false;

    // Global lane concurrency (based on DEFAULT_AGENT_MAX_CONCURRENT = 4)
    const globalLane = resolveGlobalLane();
    setLaneConcurrency(globalLane, config.maxConcurrentRuns ?? 4);

    // Tool Result Guard (based on attempt.ts → guardSessionManager())
    this.toolResultGuard = installSessionToolResultGuard(this.sessions);
  }

  // ============== Event subscription (aligned with pi-agent-core Agent) ==============

  /**
   * Subscribe to Agent events
   *
   * Based on pi-agent-core/agent.js → Agent.subscribe(fn)
   * - Returns an unsubscribe function
   * - Events are emitted synchronously during run()
   */
  subscribe(fn: (event: MiniAgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Emit event to all subscribers
   *
   * Based on pi-agent-core/agent.js → Agent.emit(e)
   */
  private emit(event: MiniAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors to avoid affecting the main flow
      }
    }
  }

  /**
   * Create SummarizeFn (used for compaction)
   *
   * Implemented via pi-ai's completeSimple, bound to the Agent's current model/apiKey
   */
  private createSummarizeFn(): SummarizeFn {
    const model = this.modelDef;
    const apiKey = this.apiKey;
    return async (params) => {
      const result = await completeSimple(model, {
        systemPrompt: params.system,
        messages: [{ role: "user", content: params.userPrompt, timestamp: Date.now() }],
      }, { maxTokens: params.maxTokens, apiKey });
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      return text.trim();
    };
  }

  /**
   * Context compaction: pruning + optional summarization
   */
  private async prepareMessagesForRun(params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
  }): Promise<{
    pruned: PruneResult;
    summary?: string;
    summaryMessage?: Message;
  }> {
    const compacted = await compactHistoryIfNeeded({
      summarize: this.createSummarizeFn(),
      messages: params.messages,
      contextWindowTokens: this.contextTokens,
    });

    if (compacted.summary && compacted.summaryMessage) {
      this.emit({
        type: "compaction",
        summaryChars: compacted.summary.length,
        droppedMessages: compacted.pruneResult.droppedMessages.length,
      });
    }

    return {
      pruned: compacted.pruneResult,
      summary: compacted.summary,
      summaryMessage: compacted.summaryMessage,
    };
  }

  /**
   * Generate the final available tool set based on policy/sandbox
   */
  private resolveToolsForRun(): Tool[] {
    let tools = [...this.tools];

    if (!this.enableMemory) {
      tools = tools.filter(
        (tool) => tool.name !== "memory_search" && tool.name !== "memory_get" && tool.name !== "memory_save",
      );
    }

    // Based on isToolAllowedByPolicies() — multi-policy intersection (all must allow)
    const sandboxPolicy = this.buildSandboxToolPolicy();
    let filtered = filterToolsByPolicy(tools, this.toolPolicy);
    filtered = filterToolsByPolicy(filtered, sandboxPolicy);
    return filtered;
  }

  /**
   * Sandbox policy (simplified version)
   */
  private buildSandboxToolPolicy(): ToolPolicy | undefined {
    if (!this.sandbox?.enabled) {
      return undefined;
    }
    const deny: string[] = [];
    if (!this.sandbox.allowExec) {
      deny.push("exec");
    }
    if (!this.sandbox.allowWrite) {
      deny.push("write", "edit");
    }
    return deny.length > 0 ? { deny } : undefined;
  }

  /**
   * Generate sub-agent sessionKey
   */
  private buildSubagentSessionKey(agentId: string): string {
    const id = crypto.randomUUID();
    return `agent:${normalizeAgentId(agentId)}:subagent:${id}`;
  }

  /**
   * Spawn sub-agent (minimal version)
   */
  private async spawnSubagent(params: {
    parentSessionKey: string;
    task: string;
    label?: string;
    cleanup?: "keep" | "delete";
  }): Promise<{ runId: string; sessionKey: string }> {
    if (isSubagentSessionKey(params.parentSessionKey)) {
      throw new Error("Sub-agent sessions cannot spawn further sub-agents");
    }
    const childSessionKey = this.buildSubagentSessionKey(this.agentId);
    const runPromise = this.run(childSessionKey, params.task);
    runPromise
      .then(async (result) => {
        const summary = result.text.slice(0, 600);
        this.emit({
          type: "subagent_summary",
          childSessionKey,
          label: params.label,
          task: params.task,
          summary,
        });
        const summaryMsg: Message = {
          role: "user",
          content: `[Sub-agent summary]\n${summary}`,
          timestamp: Date.now(),
        };
        await this.sessions.append(params.parentSessionKey, summaryMsg);
        if (params.cleanup === "delete") {
          await this.sessions.clear(childSessionKey);
        }
      })
      .catch((err) => {
        this.emit({
          type: "subagent_error",
          childSessionKey,
          label: params.label,
          task: params.task,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return {
      runId: childSessionKey,
      sessionKey: childSessionKey,
    };
  }

  /**
   * Build the complete system prompt
   */
  private async buildSystemPrompt(params?: { sessionKey?: string }): Promise<string> {
    let prompt = this.baseSystemPrompt;
    const availableTools = new Set(this.resolveToolsForRun().map((t) => t.name));

    if (this.enableContext) {
      const contextPrompt = await this.context.buildContextPrompt({
        sessionKey: params?.sessionKey,
      });
      if (contextPrompt) {
        prompt += contextPrompt;
      }
    }

    if (this.enableSkills) {
      const skillsPrompt = await this.skills.buildSkillsPrompt();
      if (skillsPrompt) {
        // Aligned with system-prompt.ts → buildSkillsSection()
        // Structured behavioral instructions telling the model how to use skills
        prompt += "\n\n## Skills (mandatory)";
        prompt += "\nBefore replying: scan <available_skills> <description> entries.";
        prompt += "\n- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.";
        prompt += "\n- If multiple could apply: choose the most specific one, then read/follow it.";
        prompt += "\n- If none clearly apply: do not read any SKILL.md.";
        prompt += "\nConstraints: never read more than one skill up front; only read after selecting.";
        prompt += skillsPrompt;
      }
    }

    if (this.enableMemory && (availableTools.has("memory_search") || availableTools.has("memory_save"))) {
      prompt += `\n\n## Memory\n- When answering questions about history, preferences, or decisions: first use memory_search to look up, then memory_get for details\n- When encountering information worth long-term storage (user preferences, key decisions, important facts): use memory_save to persist\n- Do not save casual chat or one-off queries`;
    }

    if (this.sandbox?.enabled) {
      const writeHint = this.sandbox.allowWrite ? "writable" : "read-only";
      const execHint = this.sandbox.allowExec ? "allowed" : "forbidden";
      prompt += `\n\n## Sandbox\nCurrently in sandbox mode: workspace is ${writeHint}, command execution is ${execHint}.`;
    }

    return prompt;
  }

  /**
   * Run the Agent
   */
  async run(
    sessionIdOrKey: string,
    userMessage: string,
  ): Promise<RunResult> {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    const sessionLane = resolveSessionLane(sessionKey);
    const globalLane = resolveGlobalLane();

    return enqueueInLane(sessionLane, () =>
      enqueueInLane(globalLane, async () => {
        const runId = crypto.randomUUID();

        // AbortController: each run creates an independent controller
        const runAbortController = new AbortController();
        this.runAbortControllers.set(runId, runAbortController);

        // Initialize steering queue
        if (!this.steeringQueues.has(sessionKey)) {
          this.steeringQueues.set(sessionKey, []);
        }

        this.emit({
          type: "agent_start",
          runId,
          sessionKey,
          agentId: this.agentId,
          model: this.modelDef.id,
        });

        try {
          const ctxInfo = resolveContextWindowInfo({
            contextTokens: this.contextTokens,
            defaultTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          });
          const ctxGuard = evaluateContextWindowGuard({
            info: ctxInfo,
            warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
            hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
          });
          if (ctxGuard.shouldWarn) {
            console.warn(
              `Context window is small: ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
            );
          }
          if (ctxGuard.shouldBlock) {
            throw new Error(
              `Context window too small (${ctxGuard.tokens} tokens), minimum required: ${CONTEXT_WINDOW_HARD_MIN_TOKENS} tokens.`,
            );
          }

          // Load history
          const history = await this.sessions.load(sessionKey);

          let memoriesUsed = 0;
          const toolCtx: ToolContext = {
            workspaceDir: this.workspaceDir,
            sessionKey,
            sessionId: sessionIdOrKey,
            agentId: resolveAgentIdFromSessionKey(sessionKey),
            memory: this.enableMemory ? this.memory : undefined,
            abortSignal: runAbortController.signal,
            onMemorySearch: (results) => {
              memoriesUsed += results.length;
            },
            spawnSubagent: async ({ task, label, cleanup }) =>
              this.spawnSubagent({
                parentSessionKey: sessionKey,
                task,
                label,
                cleanup,
              }),
          };

          let processedMessage = userMessage;
          let skillTriggered: string | undefined;

          // Skill matching (based on auto-reply/skill-commands.ts → model dispatch path)
          // /command args → rewrite message to guide the model to read the corresponding SKILL.md
          if (this.enableSkills) {
            const match = await this.skills.match(userMessage);
            if (match) {
              skillTriggered = match.command.skillName;
              // Rewrite message to tell the model which skill to use
              // The model scans <available_skills>, finds the corresponding skill,
              // loads SKILL.md via read tool and follows its instructions
              const userInput = match.args ?? "";
              processedMessage = `Use the "${match.command.skillName}" skill for this request.\n\nUser input:\n${userInput}`;
            }
          }

          // Heartbeat: tasks are not injected into messages here
          // Heartbeat is an independent proactive notification system,
          // reads HEARTBEAT.md and passes to LLM, does not inject into user messages

          // Add user message
          const userMsg: Message = {
            role: "user",
            content: processedMessage,
            timestamp: Date.now(),
          };
          await this.sessions.append(sessionKey, userMsg);

          const currentMessages = [...history, userMsg];

          // Compaction: run once before the loop starts
          const prep = await this.prepareMessagesForRun({
            messages: currentMessages,
            sessionKey,
            runId,
          });
          let compactionSummary = prep.summaryMessage;
          if (prep.summary) {
            let firstKeptEntryId: string | undefined;
            for (const msg of prep.pruned.messages) {
              const candidate = this.sessions.resolveMessageEntryId(sessionKey, msg);
              if (candidate) {
                firstKeptEntryId = candidate;
                break;
              }
            }
            if (firstKeptEntryId) {
              const tokensBefore = estimateMessagesTokens(currentMessages);
              await this.sessions.appendCompaction(
                sessionKey,
                prep.summary,
                firstKeptEntryId,
                tokensBefore,
              );
            } else {
              console.warn("Cannot locate firstKeptEntryId for compaction, skipping record.");
            }
          }

          // Build system prompt
          const systemPrompt = await this.buildSystemPrompt({ sessionKey });

          // Tool wrapping: inject run-level abort signal
          const rawTools = this.resolveToolsForRun();
          const toolsForRun = rawTools.map((t) => wrapToolWithAbortSignal(t, runAbortController.signal));

          // ===== Agent Loop (EventStream pattern) =====
          // Based on pi-agent-core: Agent._runLoop() → for await (const event of stream)
          const getSteeringMessages = async (): Promise<Message[]> => {
            const queue = this.steeringQueues.get(sessionKey);
            if (!queue || queue.length === 0) return [];
            const drained = queue.splice(0);
            return drained.map((text) => ({
              role: "user" as const,
              content: text,
              timestamp: Date.now(),
            }));
          };

          const stream = runAgentLoop({
            runId,
            sessionKey,
            agentId: this.agentId,
            currentMessages,
            compactionSummary,
            systemPrompt,
            toolsForRun,
            toolCtx,
            modelDef: this.modelDef,
            streamFn: this.streamFn,
            apiKey: this.apiKey,
            temperature: this.temperature,
            maxTurns: this.maxTurns,
            contextTokens: this.contextTokens,
            getSteeringMessages,
            appendMessage: (sk, msg) => this.sessions.append(sk, msg),
            prepareCompaction: async (p) => {
              const r = await this.prepareMessagesForRun(p);
              return { summary: r.summary, summaryMessage: r.summaryMessage };
            },
            abortSignal: runAbortController.signal,
          });

          // Based on pi-agent-core: for await (const event of stream) + emit + state update
          let loopError: string | undefined;
          for await (const event of stream) {
            this.emit(event);

            if (event.type === "agent_error") {
              loopError = event.error;
            }
          }

          const loopResult = await stream.result();

          if (loopError) {
            throw new Error(loopError);
          }

          return {
            runId,
            text: loopResult.finalText,
            turns: loopResult.turns,
            toolCalls: loopResult.totalToolCalls,
            skillTriggered,
            memoriesUsed,
          };
        } catch (err) {
          this.emit({
            type: "agent_error",
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          // Based on attempt.ts finally → flushPendingToolResults()
          await this.toolResultGuard.flushPendingToolResults(sessionKey);
          this.runAbortControllers.delete(runId);
        }
      }),
    );
  }

  /**
   * Abort a run
   *
   * Based on pi-embedded-runner/run/attempt.ts → abortRun()
   */
  abort(runId?: string): void {
    if (runId) {
      const controller = this.runAbortControllers.get(runId);
      if (controller) {
        controller.abort();
      }
    } else {
      for (const controller of this.runAbortControllers.values()) {
        controller.abort();
      }
    }
  }

  /**
   * Inject a steering message into a running session
   *
   * Based on pi-agent-core → session.steer(text) / agent.steeringQueue
   */
  steer(sessionKey: string, text: string): void {
    const queue = this.steeringQueues.get(sessionKey);
    if (queue) {
      queue.push(text);
    } else {
      this.steeringQueues.set(sessionKey, [text]);
    }
  }

  /**
   * Start Heartbeat monitoring
   *
   * Heartbeat is an independent proactive notification system.
   * The callback receives raw HEARTBEAT.md content (no task parsing),
   * and the caller decides how to handle it (usually by calling the LLM).
   */
  startHeartbeat(callback?: (content: string, reason: string) => void): void {
    if (callback) {
      this.heartbeat.onHeartbeat(async (opts): Promise<{ text?: string } | null> => {
        callback(opts.content, opts.reason);
        return null;
      });
    }
    this.heartbeat.start();
  }

  /**
   * Stop Heartbeat monitoring
   */
  stopHeartbeat(): void {
    this.heartbeat.stop();
  }

  /**
   * Manually trigger a Heartbeat check
   */
  async triggerHeartbeat(): Promise<HeartbeatResult> {
    return this.heartbeat.trigger();
  }

  /**
   * Reset session
   */
  async reset(sessionIdOrKey: string): Promise<void> {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    await this.sessions.clear(sessionKey);
  }

  /**
   * Get session history
   */
  getHistory(sessionIdOrKey: string): Message[] {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    return this.sessions.get(sessionKey);
  }

  /**
   * List sessions
   */
  async listSessions(): Promise<string[]> {
    return this.sessions.list();
  }

  // ===== Subsystem accessors =====

  getMemory(): MemoryManager {
    return this.memory;
  }

  getContext(): ContextLoader {
    return this.context;
  }

  getSkills(): SkillManager {
    return this.skills;
  }

  getHeartbeat(): HeartbeatManager {
    return this.heartbeat;
  }
}
