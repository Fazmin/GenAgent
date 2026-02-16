/**
 * Gen Agent - Minimal AI Agent Framework
 *
 * Module layers:
 *
 * [Core Layer] Fundamental capabilities needed by any Agent
 *   - Agent Loop (dual-loop + EventStream)
 *   - Session (session persistence)
 *   - Context (context loading + pruning + summary compaction)
 *   - Tools (tool abstraction + built-in tools)
 *   - Provider (multi-model adapter)
 *
 * [Extension Layer] Advanced features, not required for generic Agents
 *   - Memory (long-term memory - keyword search)
 *   - Skills (skill system - SKILL.md trigger word matching)
 *   - Heartbeat (proactive activation - timer/event driven)
 *
 * [Engineering Layer] Production-grade safeguards, can be skipped for learning
 *   - Session Key (multi-agent session key normalization)
 *   - Tool Policy (three-level tool access control)
 *   - Command Queue (concurrency lane control)
 *   - Sandbox Paths / Context Window Guard / Tool Result Guard
 */

// =============================================
// [Core Layer] Core - needed by any Agent
// =============================================

// Agent entry + run result
export { Agent, type AgentConfig, type RunResult } from "./agent.js";

// Agent Loop — dual-loop (outer=follow-up, inner=tools+steering)
export { runAgentLoop, type AgentLoopParams } from "./agent-loop.js";

// EventStream — 18 typed events, async push-pull model
export {
  type MiniAgentEvent,
  type MiniAgentResult,
  createMiniAgentStream,
} from "./agent-events.js";

// Session — JSONL persistence + history management
export { SessionManager, type Message, type ContentBlock } from "./session.js";

// Context — on-demand loading (AGENTS.md etc.) + pruning + summary compaction
export { ContextLoader, type ContextFile } from "./context/index.js";

// Tools — tool abstraction + built-in tools (read/write/edit/exec/list/grep/memory_save)
export {
  type Tool,
  type ToolContext,
  type ToolCall,
  type ToolResult,
  builtinTools,
  readTool,
  writeTool,
  editTool,
  execTool,
  listTool,
  grepTool,
  memorySaveTool,
} from "./tools/index.js";

// Provider — multi-model adapter layer (based on pi-ai, supports 22+ providers)
export {
  type Api,
  type Provider,
  type Model,
  type StreamFunction,
  type StreamOptions,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ThinkingLevel,
  type StopReason,
  stream,
  streamSimple,
  streamAnthropic,
  getModel,
  getModels,
  isContextOverflow,
  createAssistantMessageEventStream,
  FailoverError,
  isFailoverError,
  type FailoverReason,
  type RetryOptions,
  retryAsync,
  isContextOverflowError,
  classifyFailoverReason,
  describeError,
} from "./provider/index.js";

// Message format conversion (internal messages → pi-ai format)
export { convertMessagesToPi } from "./message-convert.js";

// =============================================
// [Extension Layer] Extended - advanced features, not universally required
// =============================================

// Memory — long-term memory (keyword search + time decay)
export {
  MemoryManager,
  type MemoryEntry,
  type MemorySource,
  type MemorySearchResult,
} from "./memory.js";

// Skills — skill system (SKILL.md frontmatter + trigger word matching)
export {
  SkillManager,
  type Skill,
  type SkillMatch,
  type SkillEntry,
  type SkillCommandSpec,
  type SkillInvocationPolicy,
} from "./skills.js";

// Heartbeat — proactive activation (two-layer architecture: wake request merging + runner scheduling)
export {
  HeartbeatManager,
  type HeartbeatConfig,
  type HeartbeatCallback,
  type HeartbeatResult,
  type HeartbeatHandler,
  type WakeReason,
  type WakeRequest,
  type ActiveHours,
} from "./heartbeat.js";

// =============================================
// [Engineering Layer] Production - production-grade safeguards, can be skipped for learning
// =============================================

// Session Key — multi-agent session key normalization (agent:agentId:sessionId)
export {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  resolveSessionKey,
  parseAgentSessionKey,
  isSubagentSessionKey,
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.js";

// Tool Policy — tool access control (allow/deny/none three-level compilation)
export { type ToolPolicy, filterToolsByPolicy } from "./tool-policy.js";
