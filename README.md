# GenAgent

**A blueprint for how AI Agent systems actually work under the hood.**

> "An AI without memory is just a function mapping. An AI with memory and proactive activation is an evolving living system."

## The Story Behind This

Over the past year, I have been building multiple projects that involve AI agents. Across all of them, I kept running into the same questions: How should an agent manage its conversation history when the context window fills up? How does it decide when to use a tool versus just respond with text? How do you make an agent remember things between sessions, or even act on its own without waiting for a prompt?

Every tutorial I found online only showed the basics, the simple loop where you call an LLM, run some tools, and repeat. But none of them addressed the real architectural challenges that show up once you try to build something production-ready.

So I started sketching out a blueprint for how a proper agent system should be structured. Not just the loop, but everything around it: session persistence, context management, memory, skills, concurrency control, and proactive behavior. Eventually that blueprint turned into this project. GenAgent is the result of distilling those ideas into a minimal but complete implementation that captures how these systems actually perform at a deeper level.

## What Is This, Simply Put?

Think of an AI agent as a smart assistant that can not only talk to you, but also take actions: read files, run commands, search the web, and remember things you told it last week.

GenAgent is a working reference implementation that shows how all the pieces of such a system fit together:

- **The brain** - An LLM (like Claude or GPT) that decides what to do next
- **The hands** - Tools that let the agent interact with the real world (read/write files, run shell commands, search code)
- **The memory** - A system that stores important facts across conversations so the agent does not start from scratch every time
- **The conversation log** - Persistent session history saved to disk, so the agent can pick up right where it left off after a restart
- **The context manager** - Smart pruning and summarization that keeps conversations within the LLM's token limits without losing critical information
- **The heartbeat** - A mechanism that lets the agent wake up and act on its own, not just wait for you to say something

It supports 22+ LLM providers (Anthropic, OpenAI, Google, Groq, and more), and the whole thing is built in TypeScript.

## Why This Matters

Most Agent tutorials online only cover the basic Agent Loop:

```python
while tool_calls:
    response = llm.generate(messages)
    for tool in tools:
        result = tool.execute()
        messages.append(result)
```

**This is not a real Agent architecture.** A production-grade Agent requires system-level design decisions that go far beyond a simple loop.

GenAgent distills core design patterns and minimal implementations from a complex Agent system, helping you understand:

- The dual-layer Agent Loop and EventStream event flow
- Session persistence and context management (pruning + summary compaction)
- Long-term memory, skill systems, and proactive activation
- Multi-provider adaptation (Anthropic / OpenAI / Google / Groq and 22+ other providers)

---

## Module Architecture

The project is organized into three layers by learning value. It is recommended to read them in this order: **Core > Extended > Production**.

#### Layer 3 - Production *(can be skipped)*
> Production-grade guards and controls
>
> `session-key` `tool-policy` `command-queue` `sandbox-paths` `context-window-guard` `tool-result-guard`

#### Layer 2 - Extended *(optional)*
> Advanced features, not required for all Agents
>
> `Memory` (long-term) / `Skills` (skill system) / `Heartbeat` (proactive activation)

#### Layer 1 - Core *(start here)*
> Foundational capabilities every Agent needs
>
> `Agent Loop` (dual-layer loop) / `EventStream` (18 typed events) / `Session` (JSONL persistence) / `Context` (load + prune + compact) / `Tools` (abstraction + built-in) / `Provider` (multi-model adapter)

### Core Layer (Must Read)

| Module | File | Key Responsibility |
|--------|------|--------------------|
| **Agent** | `agent.ts` | Entry point + subscribe/emit event dispatch |
| **Agent Loop** | `agent-loop.ts` | Dual-layer loop (outer = follow-up, inner = tools + steering) |
| **EventStream** | `agent-events.ts` | 18 discriminated union MiniAgentEvent types + async push/pull |
| **Session** | `session.ts` | JSONL persistence, history management |
| **Context Loader** | `context/loader.ts` | On-demand loading of bootstrap files like AGENTS.md |
| **Pruning** | `context/pruning.ts` | Three-stage progressive pruning (tool_result > assistant > keep recent) |
| **Compaction** | `context/compaction.ts` | Adaptive chunked summary compaction |
| **Tools** | `tools/*.ts` | Tool abstraction + 7 built-in tools |
| **Provider** | `provider/*.ts` | Multi-model adaptation layer (22+ providers) |

### Extended Layer (Optional)

| Module | File | Key Responsibility |
|--------|------|--------------------|
| **Memory** | `memory.ts` | Long-term memory (keyword search + time decay) |
| **Skills** | `skills.ts` | SKILL.md frontmatter + trigger keyword matching |
| **Heartbeat** | `heartbeat.ts` | Two-layer architecture: wake request merging + runner scheduling |

### Production Layer (Can Skip)

| Module | File | Key Responsibility |
|--------|------|--------------------|
| **Session Key** | `session-key.ts` | Multi-agent session key normalization (`agent:id:session`) |
| **Tool Policy** | `tool-policy.ts` | Three-tier tool access control (allow / deny / none) |
| **Command Queue** | `command-queue.ts` | Concurrency lane control (session serial + global parallel) |
| **Tool Result Guard** | `session-tool-result-guard.ts` | Auto-fills missing tool_result entries |
| **Context Window Guard** | `context-window-guard.ts` | Context window overflow protection |
| **Sandbox Paths** | `sandbox-paths.ts` | Path safety validation |

---

## Core Design Breakdown

### 1. Agent Loop: Dual-Layer Loop + EventStream

**Problem**: A simple while loop cannot handle follow-ups, steering injection, context overflow, and other complex scenarios.

**Solution**: Dual-layer loop + EventStream event flow

```typescript
// agent-loop.ts - Returns an EventStream, IIFE pushes events
function runAgentLoop(params): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();

  (async () => {
    // Outer loop: follow-up cycle (handles end_turn / tool_use continuation)
    while (outerTurn < maxOuterTurns) {
      // Inner loop: tool execution + steering injection
      // stream.push({ type: "tool_execution_start", ... })
    }
    stream.end({ text, turns, toolCalls });
  })();

  return stream; // Caller consumes via for-await
}
```

**Event Subscription** (aligned with pi-agent-core `Agent.subscribe`):

```typescript
const agent = new Agent({ apiKey, provider: "anthropic" });

const unsubscribe = agent.subscribe((event) => {
  switch (event.type) {
    case "message_delta": // Streaming text
      process.stdout.write(event.delta);
      break;
    case "tool_execution_start": // Tool started
      console.log(`[${event.toolName}]`, event.args);
      break;
    case "agent_error": // Runtime error
      console.error(event.error);
      break;
  }
});

const result = await agent.run(sessionKey, "List the files in the current directory");
unsubscribe();
```

### 2. Session Manager: JSONL Persistence

**Problem**: How does the Agent restore conversation context after a restart?

```typescript
// session.ts - Append-only writes, one message per line
async append(sessionId: string, message: Message): Promise<void> {
  const filePath = this.getFilePath(sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(message) + "\n");
}
```

### 3. Context: Load + Prune + Summary Compaction

**Problem**: The context window is limited. How do you control its size without losing critical information?

Three-stage progressive strategy:

1. **Pruning** - Trim old tool_result entries (keep the most recent N intact)
2. **Compaction** - When exceeding a threshold, compress older messages into a "history summary"
3. **Bootstrap** - On-demand loading of config files like AGENTS.md (oversized files are head+tail truncated)

### 4. Memory: Long-Term Memory (Extended Layer)

**Problem**: How does an Agent "remember" information across sessions?

```typescript
// memory.ts - Keyword matching + time decay
async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryTerms = query.toLowerCase().split(/\s+/);
  for (const entry of this.entries) {
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score += 1;
      if (entry.tags.some(t => t.includes(term))) score += 0.5;
    }
    const recencyBoost = Math.max(0, 1 - ageHours / (24 * 30));
    score += recencyBoost * 0.3;
  }
}
```

Production systems typically use SQLite-vec for vector semantic search + BM25 keyword search. This project simplifies it to pure keyword matching.

### 5. Heartbeat: Proactive Activation (Extended Layer)

**Problem**: How does an Agent work "proactively" instead of only responding passively?

Two-layer architecture:

- **HeartbeatWake** (Request Merging Layer): Multi-source triggers (interval / cron / exec / requested) with a 250ms merge window and double buffering
- **HeartbeatRunner** (Scheduling Layer): Active time checking, HEARTBEAT.md parsing, empty content skipping, and duplicate suppression

| Design Decision | Rationale |
|-----------------|-----------|
| setTimeout instead of setInterval | Precisely calculates next run time to prevent drift |
| 250ms merge window | Prevents multiple events from triggering simultaneously |
| Double buffering | New requests received during execution are not lost |
| Duplicate suppression | Identical messages are not repeated within 24 hours |

---

## Design Pattern Index

| Pattern | File | Description |
|---------|------|-------------|
| EventStream async push/pull | `agent-events.ts` | push / asyncIterator / end / result |
| Subscribe/Emit observer | `agent.ts` | Listeners Set + subscribe returns unsubscribe |
| Dual-layer loop | `agent-loop.ts` | Outer (follow-up) + inner (tools + steering) |
| JSONL append log | `session.ts` | One message per line, append-only writes |
| Three-stage progressive pruning | `context/pruning.ts` | tool_result > assistant > keep recent |
| Adaptive chunked summary | `context/compaction.ts` | Chunk by token count, summarize each chunk |
| Double-buffer scheduling | `heartbeat.ts` | Running + scheduled state machine |
| Three-tier compilation strategy | `tool-policy.ts` | allow / deny / none to filter tool list |

---

## Quick Start

```bash
npm install
```

### Configure API Keys

Copy the example env file and add your key(s):

```bash
cp .env.example .env
```

Then edit `.env` with your API key:

```env
ANTHROPIC_API_KEY=sk-xxx
```

Alternatively, you can export the key directly or pass it as a CLI flag:

```bash
# Export as environment variable
export ANTHROPIC_API_KEY=sk-xxx

# Or pass via CLI flag
pnpm dev -- --api-key sk-xxx
```

### Run

```bash
# Anthropic (default)
pnpm dev

# OpenAI (requires OPENAI_API_KEY in .env)
pnpm dev -- --provider openai

# Google (requires GEMINI_API_KEY in .env)
pnpm dev -- --provider google

# Specify a model
pnpm dev -- --provider openai --model gpt-4o

# Specify an agentId
pnpm dev -- --agent my-agent
```

## Usage Example

```typescript
import { Agent } from "gen-agent";

const agent = new Agent({
  provider: "anthropic",       // Supports 22+ providers
  // apiKey defaults to reading from environment variables if omitted
  agentId: "main",
  workspaceDir: process.cwd(),
  enableMemory: true,
  enableContext: true,
  enableSkills: true,
  enableHeartbeat: false,
});

// Event subscription
const unsubscribe = agent.subscribe((event) => {
  if (event.type === "message_delta") {
    process.stdout.write(event.delta);
  }
});

const result = await agent.run("session-1", "List the files in the current directory");
console.log(`${result.turns} turns, ${result.toolCalls} tool calls`);

unsubscribe();
```

## Suggested Learning Path

1. **Start with the Core Layer**: `agent-loop.ts` > `agent.ts` > `agent-events.ts` > `session.ts` > `context/`
2. **Understand the event flow**: subscribe/emit pattern + EventStream async push/pull
3. **Explore the Extended Layer**: `memory.ts` > `skills.ts` > `heartbeat.ts` (based on interest)
4. **Cross-reference the original source**: Verify whether the simplified version captures the core design
5. **Skip the Production Layer**: Unless you are building a production-grade Agent, this is not required

## License

MIT
