/**
 * Message format conversion: internal Message[] → pi-ai Message[]
 *
 * pi-ai uses three roles: "user" / "assistant" / "toolResult"
 * Internal format: role is only "user" / "assistant"; tool_result is embedded in user message content
 */

import type { Message } from "./session.js";
import type {
  Message as PiMessage,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Convert internal Message[] to pi-ai Message[]
 *
 * Conversion rules:
 * - user + string content → PiUserMessage
 * - user + ContentBlock[] with tool_result → split into independent PiToolResultMessage
 * - user + ContentBlock[] with text → PiUserMessage
 * - assistant + ContentBlock[] → PiAssistantMessage (tool_use → ToolCall)
 */
export function convertMessagesToPi(
  messages: Message[],
  modelInfo: { api: string; provider: string; id: string },
): PiMessage[] {
  const result: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        });
        continue;
      }

      const textParts: PiTextContent[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_result") {
          result.push({
            role: "toolResult",
            toolCallId: block.tool_use_id ?? "",
            toolName: block.name ?? "",
            content: [{ type: "text", text: typeof block.content === "string" ? block.content : "" }],
            isError: false,
            timestamp: msg.timestamp,
          });
        }
      }
      if (textParts.length > 0) {
        result.push({
          role: "user",
          content: textParts,
          timestamp: msg.timestamp,
        });
      }
    } else {
      // assistant
      if (typeof msg.content === "string") {
        result.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: msg.timestamp,
        });
        continue;
      }

      const piContent: (PiTextContent | PiToolCall)[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          piContent.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          piContent.push({
            type: "toolCall",
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: block.input ?? {},
          });
        }
      }

      result.push({
        role: "assistant",
        content: piContent,
        api: modelInfo.api,
        provider: modelInfo.provider,
        model: modelInfo.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: msg.timestamp,
      });
    }
  }

  return result;
}
