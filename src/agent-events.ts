/**
 * Agent event type definitions
 *
 * Based on:
 * - pi-agent-core/types.d.ts → AgentEvent discriminated union type
 * - pi-ai/utils/event-stream.js → EventStream<T, R> generic event stream
 *
 * Architecture:
 * - Global event bus → removed (was emitAgentEvent / onAgentEvent)
 * - Replacement: Agent instance-level subscribe()/emit() pattern
 *   (based on pi-agent-core Agent.listeners + Agent.emit())
 * - EventStream imported directly from pi-ai (DRY, no re-implementation)
 *
 * Event flow (three-layer architecture):
 *   Layer 1: agent-loop → stream.push(MiniAgentEvent) → EventStream queue
 *   Layer 2: Agent.run() → for await (event of stream) → consume events
 *   Layer 3: Agent.emit(event) → listeners → external subscribers (CLI, etc.)
 */

import { EventStream } from "@mariozechner/pi-ai";
import type { Message } from "./session.js";

// ============== Event types (discriminated union) ==============

/**
 * Agent event type
 *
 * Based on pi-agent-core AgentEvent, adapted for Gen Agent's Message type:
 * - Core lifecycle: agent_start → agent_end / agent_error
 * - Turn: turn_start → turn_end
 * - Message: message_start → message_delta* → message_end
 * - Tool: tool_execution_start → tool_execution_end / tool_skipped
 * - Gen Agent specific: compaction, retry, steering, subagent, context_overflow_compact
 */
export type MiniAgentEvent =
  // Core lifecycle (aligned with pi-agent-core: agent_start / agent_end)
  | { type: "agent_start"; runId: string; sessionKey: string; agentId: string; model: string }
  | { type: "agent_end"; runId: string; messages: Message[] }
  | { type: "agent_error"; runId: string; error: string }

  // Turn (aligned with pi-agent-core: turn_start / turn_end)
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }

  // Message (aligned with pi-agent-core: message_start / message_update / message_end)
  | { type: "message_start"; message: Message }
  | { type: "message_delta"; delta: string }
  | { type: "message_end"; message: Message; text: string }

  // Tool execution (aligned with pi-agent-core: tool_execution_start / tool_execution_end)
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: "tool_skipped"; toolCallId: string; toolName: string }

  // Gen Agent specific events
  | { type: "steering"; pendingCount: number }
  | { type: "compaction"; summaryChars: number; droppedMessages: number }
  | { type: "context_overflow_compact"; error: string }
  | { type: "retry"; attempt: number; delay: number; error: string }
  | { type: "subagent_summary"; childSessionKey: string; label?: string; task: string; summary: string }
  | { type: "subagent_error"; childSessionKey: string; label?: string; task: string; error: string };

// ============== Result type ==============

/**
 * Final result of the EventStream
 *
 * Extracted via extractResult when the stream receives a terminal event (agent_end / agent_error)
 */
export interface MiniAgentResult {
  finalText: string;
  turns: number;
  totalToolCalls: number;
  messages: Message[];
}

// ============== Factory function ==============

/**
 * Create an Agent event stream
 *
 * Based on pi-agent-core/agent-loop.js → createAgentStream()
 * - isComplete: agent_end or agent_error are terminal events
 * - extractResult: extracts MiniAgentResult from the terminal event
 */
export function createMiniAgentStream(): EventStream<MiniAgentEvent, MiniAgentResult> {
  return new EventStream<MiniAgentEvent, MiniAgentResult>(
    (event) => event.type === "agent_end" || event.type === "agent_error",
    (event) => {
      if (event.type === "agent_end") {
        return { finalText: "", turns: 0, totalToolCalls: 0, messages: event.messages };
      }
      // agent_error
      return { finalText: "", turns: 0, totalToolCalls: 0, messages: [] };
    },
  );
}
