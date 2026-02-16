"use client";

import { useState, useCallback, useRef } from "react";
import type { Message, StreamingMessage, ToolExecution } from "@/lib/types";

export function useChat(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingMessage, setStreamingMessage] =
    useState<StreamingMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadMessages = useCallback(
    async (convId?: string) => {
      const id = convId || conversationId;
      if (!id) return;
      try {
        const res = await fetch(`/api/conversations/${id}/messages`);
        if (res.ok) {
          const data = await res.json();
          setMessages(data);
        }
      } catch (error) {
        console.error("Failed to load messages:", error);
      }
    },
    [conversationId]
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversationId || !content.trim() || isLoading) return;

      setIsLoading(true);
      abortControllerRef.current = new AbortController();

      const userMessage: Message = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        role: "user",
        content: content.trim(),
        tool_name: null,
        tool_call_id: null,
        is_error: 0,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMessage]);

      const streamMsg: StreamingMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        isStreaming: true,
        toolExecutions: [],
      };
      setStreamingMessage(streamMsg);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            message: content.trim(),
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Failed to send message");
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ") && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                handleSSEEvent(currentEvent, data, setStreamingMessage);
              } catch {
                // skip parse errors
              }
              currentEvent = "";
            }
          }
        }

        setStreamingMessage((current) => {
          if (current && current.content) {
            const finalMsg: Message = {
              id: current.id,
              conversation_id: conversationId,
              role: "assistant",
              content: current.content,
              tool_name: null,
              tool_call_id: null,
              is_error: 0,
              created_at: new Date().toISOString(),
            };

            const toolMessages: Message[] = current.toolExecutions
              .filter((t) => t.result !== undefined)
              .map((t) => ({
                id: crypto.randomUUID(),
                conversation_id: conversationId,
                role: "tool" as const,
                content: t.result || "",
                tool_name: t.toolName,
                tool_call_id: t.toolCallId,
                is_error: t.isError ? 1 : 0,
                created_at: new Date().toISOString(),
              }));

            setMessages((prev) => [...prev, ...toolMessages, finalMsg]);
          }
          return null;
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          // User cancelled
        } else {
          console.error("Chat error:", error);
          const errorMsg: Message = {
            id: crypto.randomUUID(),
            conversation_id: conversationId,
            role: "assistant",
            content: `Error: ${error instanceof Error ? error.message : "Something went wrong"}`,
            tool_name: null,
            tool_call_id: null,
            is_error: 1,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
        setStreamingMessage(null);
      } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    },
    [conversationId, isLoading]
  );

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingMessage(null);
  }, []);

  return {
    messages,
    streamingMessage,
    isLoading,
    loadMessages,
    sendMessage,
    stopGeneration,
    clearMessages,
  };
}

function handleSSEEvent(
  event: string,
  data: Record<string, unknown>,
  setStreamingMessage: React.Dispatch<
    React.SetStateAction<StreamingMessage | null>
  >
) {
  switch (event) {
    case "message_delta":
      setStreamingMessage((prev) => {
        if (!prev) return prev;
        return { ...prev, content: prev.content + (data.delta as string) };
      });
      break;

    case "tool_start":
      setStreamingMessage((prev) => {
        if (!prev) return prev;
        const tool: ToolExecution = {
          toolCallId: data.toolCallId as string,
          toolName: data.toolName as string,
          args: data.args,
          status: "running",
        };
        return {
          ...prev,
          toolExecutions: [...prev.toolExecutions, tool],
        };
      });
      break;

    case "tool_end":
      setStreamingMessage((prev) => {
        if (!prev) return prev;
        const toolExecutions = prev.toolExecutions.map((t) =>
          t.toolCallId === (data.toolCallId as string)
            ? {
                ...t,
                result: data.result as string,
                isError: data.isError as boolean,
                status: (data.isError ? "error" : "completed") as
                  | "completed"
                  | "error",
              }
            : t
        );
        return { ...prev, toolExecutions };
      });
      break;

    case "message_end":
      setStreamingMessage((prev) => {
        if (!prev) return prev;
        return { ...prev, isStreaming: false };
      });
      break;

    case "error":
      setStreamingMessage((prev) => {
        if (!prev) return prev;
        const errorText = data.error as string;
        return {
          ...prev,
          content: prev.content
            ? prev.content + "\n\n[Error: " + errorText + "]"
            : "Error: " + errorText,
          isStreaming: false,
        };
      });
      break;
  }
}
