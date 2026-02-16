/**
 * Session Tool Result Guard
 *
 * Tracks tool_use calls in assistant messages and ensures each has a corresponding tool_result.
 * When a new message arrives but there are unmatched tool_use calls, automatically synthesizes
 * error results (synthetic error results).
 *
 * Purpose:
 * - Prevents LLM API from rejecting incomplete tool_use/tool_result pairs
 * - Handles missing results caused by agent crashes or interruptions mid-execution
 *
 * Architecture notes:
 * - tool_result is a ContentBlock inside a user message
 * - Core logic: track pending → match and clear → flush synthetic results
 */

import type { SessionManager, Message, ContentBlock } from "./session.js";

type ToolCall = { id: string; name?: string };

/**
 * Extract tool_use calls from an assistant message
 *
 * Unified to type: "tool_use" (Anthropic API format)
 */
function extractToolUsesFromAssistant(msg: Message): ToolCall[] {
  if (msg.role !== "assistant" || typeof msg.content === "string") return [];
  const calls: ToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.id) {
      calls.push({ id: block.id, name: block.name });
    }
  }
  return calls;
}

/**
 * Extract tool_use_id values from tool_result blocks in a user message
 *
 * tool_result is a ContentBlock; checks tool_use_id
 */
function extractToolResultIds(msg: Message): string[] {
  if (msg.role !== "user" || typeof msg.content === "string") return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_result" && block.tool_use_id) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

/**
 * Generate a synthetic placeholder for a missing tool result
 *
 * - isError: true semantics (expressed through content text)
 */
function makeMissingToolResult(toolCallId: string, toolName?: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: toolCallId,
    name: toolName,
    content:
      "[gen-agent] missing tool result in session history; inserted synthetic error result for transcript repair.",
  };
}

export { makeMissingToolResult };

/**
 * Install the tool result guard
 *
 * Monkey-patches SessionManager.append() to intercept message appends:
 * 1. assistant message → track pending tool_use IDs
 * 2. user message (containing tool_result) → clear matching pending IDs
 * 3. Other messages arrive while pending is non-empty → auto-flush synthetic results
 *
 * Idempotent: multiple calls will not install duplicates
 */
export function installSessionToolResultGuard(sessionManager: SessionManager): {
  flushPendingToolResults: (sessionKey: string) => Promise<void>;
  getPendingIds: (sessionKey: string) => string[];
} {
  // Idempotent check
  const sm = sessionManager as SessionManager & {
    __toolResultGuardInstalled?: boolean;
    __toolResultGuard?: ReturnType<typeof installSessionToolResultGuard>;
  };
  if (sm.__toolResultGuardInstalled && sm.__toolResultGuard) {
    return sm.__toolResultGuard;
  }

  const originalAppend = sessionManager.append.bind(sessionManager);

  // Per-session pending tracking (one SessionManager manages multiple sessions)
  const pendingBySession = new Map<string, Map<string, string | undefined>>();

  function getPending(sessionKey: string): Map<string, string | undefined> {
    let m = pendingBySession.get(sessionKey);
    if (!m) {
      m = new Map();
      pendingBySession.set(sessionKey, m);
    }
    return m;
  }

  /**
   * Flush all pending tool results
   *
   * For each unmatched tool_use, generate a synthetic error result,
   * package them into a single user message and append to the session
   */
  const flushPendingToolResults = async (sessionKey: string): Promise<void> => {
    const pending = pendingBySession.get(sessionKey);
    if (!pending || pending.size === 0) return;
    const results: ContentBlock[] = [];
    for (const [id, name] of pending.entries()) {
      results.push(makeMissingToolResult(id, name));
    }
    pending.clear();
    await originalAppend(sessionKey, {
      role: "user",
      content: results,
      timestamp: Date.now(),
    });
  };

  /**
   * Monkey-patched append
   *
   * Evaluation order:
   * 1. user message contains tool_result → clear matching pending IDs, append directly
   * 2. pending is non-empty and message is not tool_result → flush first, then append
   * 3. pending is non-empty and new assistant has tool_use → flush old pending, then append
   * 4. assistant message has tool_use → append then record pending
   */
  sessionManager.append = async (sessionKey: string, message: Message): Promise<void> => {
    const pending = getPending(sessionKey);

    // user message contains tool_result → clear matching pending
    const resultIds = extractToolResultIds(message);
    if (resultIds.length > 0) {
      for (const id of resultIds) {
        pending.delete(id);
      }
      return originalAppend(sessionKey, message);
    }

    const toolCalls = extractToolUsesFromAssistant(message);

    // Non-toolResult message arrives but there are pending entries → flush
    if (pending.size > 0 && toolCalls.length === 0) {
      await flushPendingToolResults(sessionKey);
    }
    // New assistant with tool_use but old pending still present → flush old
    if (pending.size > 0 && toolCalls.length > 0) {
      await flushPendingToolResults(sessionKey);
    }

    await originalAppend(sessionKey, message);

    // Track new tool_use calls
    for (const call of toolCalls) {
      pending.set(call.id, call.name);
    }
  };

  const guard = {
    flushPendingToolResults,
    getPendingIds: (sessionKey: string): string[] => {
      const pending = pendingBySession.get(sessionKey);
      return pending ? Array.from(pending.keys()) : [];
    },
  };

  sm.__toolResultGuardInstalled = true;
  sm.__toolResultGuard = guard;
  return guard;
}
