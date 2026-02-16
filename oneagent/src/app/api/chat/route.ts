import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import {
  addMessage,
  updateConversationTitle,
  updateConversationTimestamp,
  getConversation,
  createConversation,
} from "@/lib/db";
import { getOrCreateAgent } from "@/lib/agent";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { conversationId, message } = body;

    if (!conversationId || !message) {
      return NextResponse.json(
        { error: "conversationId and message are required" },
        { status: 400 }
      );
    }

    let conversation = getConversation(conversationId);
    if (!conversation) {
      conversation = createConversation(conversationId);
    }

    const userMsgId = uuid();
    addMessage(userMsgId, conversationId, "user", message);

    const agent = await getOrCreateAgent();
    const sessionKey = `oneagent:${conversationId}`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        let fullText = "";
        let currentToolCalls: Array<{
          id: string;
          name: string;
          args: unknown;
        }> = [];
        let assistantMsgId = uuid();

        const unsubscribe = agent.subscribe((event: any) => {
          switch (event.type) {
            case "message_start":
              sendEvent("message_start", { messageId: assistantMsgId });
              break;

            case "message_delta":
              fullText += event.delta;
              sendEvent("message_delta", { delta: event.delta });
              break;

            case "message_end":
              sendEvent("message_end", {
                messageId: assistantMsgId,
                text: fullText,
              });
              break;

            case "tool_execution_start":
              currentToolCalls.push({
                id: event.toolCallId,
                name: event.toolName,
                args: event.args,
              });
              sendEvent("tool_start", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              });
              break;

            case "tool_execution_end":
              sendEvent("tool_end", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError,
              });

              const toolMsgId = uuid();
              addMessage(
                toolMsgId,
                conversationId,
                "tool",
                event.result,
                event.toolName,
                event.toolCallId,
                event.isError
              );
              break;

            case "tool_skipped":
              sendEvent("tool_skipped", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
              break;

            case "agent_error":
              sendEvent("error", { error: event.error });
              break;

            case "compaction":
              sendEvent("compaction", {
                summaryChars: event.summaryChars,
                droppedMessages: event.droppedMessages,
              });
              break;

            case "turn_start":
              sendEvent("turn_start", { turn: event.turn });
              break;

            case "turn_end":
              sendEvent("turn_end", { turn: event.turn });
              break;
          }
        });

        try {
          const result = await agent.run(sessionKey, message);

          if (fullText) {
            addMessage(assistantMsgId, conversationId, "assistant", fullText);
          }

          const isFirstMessage =
            conversation && conversation.title === "New Chat";
          if (isFirstMessage && message.length > 0) {
            const title =
              message.length > 50 ? message.substring(0, 50) + "..." : message;
            updateConversationTitle(conversationId, title);
          }

          updateConversationTimestamp(conversationId);

          sendEvent("done", {
            turns: result.turns,
            toolCalls: result.toolCalls,
            memoriesUsed: result.memoriesUsed,
          });
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          sendEvent("error", { error: errMsg });

          if (fullText) {
            addMessage(
              assistantMsgId,
              conversationId,
              "assistant",
              fullText + "\n\n[Error: " + errMsg + "]"
            );
          }
        } finally {
          unsubscribe();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process chat" },
      { status: 500 }
    );
  }
}
