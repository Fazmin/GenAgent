"use client";

import { useMemo } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bot, User, Wrench, AlertCircle } from "lucide-react";
import type { Message, ToolExecution } from "@/lib/types";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isError = message.is_error === 1;

  if (isTool) {
    return <ToolMessageBubble message={message} />;
  }

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      {!isUser && (
        <div className="flex-shrink-0 mt-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" />
          </div>
        </div>
      )}

      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2.5",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
          isError && "border border-destructive/50 bg-destructive/10"
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {isUser && (
        <div className="flex-shrink-0 mt-0.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary">
            <User className="h-4 w-4" />
          </div>
        </div>
      )}
    </div>
  );
}

function ToolMessageBubble({ message }: { message: Message }) {
  const isError = message.is_error === 1;
  const resultPreview = useMemo(() => {
    const text = message.content;
    if (text.length <= 300) return text;
    return text.slice(0, 300) + "...";
  }, [message.content]);

  return (
    <div className="flex gap-3 px-4 py-1.5 justify-start">
      <div className="w-8 flex-shrink-0" />
      <div
        className={cn(
          "max-w-[80%] rounded-lg border px-3 py-2 text-xs",
          isError
            ? "border-destructive/30 bg-destructive/5"
            : "border-border bg-card"
        )}
      >
        <div className="flex items-center gap-1.5 mb-1">
          {isError ? (
            <AlertCircle className="h-3 w-3 text-destructive" />
          ) : (
            <Wrench className="h-3 w-3 text-muted-foreground" />
          )}
          <Badge variant={isError ? "destructive" : "secondary"} className="text-[10px] px-1.5 py-0">
            {message.tool_name || "tool"}
          </Badge>
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground overflow-x-auto">
          {resultPreview}
        </pre>
      </div>
    </div>
  );
}

// Streaming message component
interface StreamingMessageBubbleProps {
  content: string;
  toolExecutions: ToolExecution[];
  isStreaming: boolean;
}

export function StreamingMessageBubble({
  content,
  toolExecutions,
  isStreaming,
}: StreamingMessageBubbleProps) {
  return (
    <div className="space-y-0">
      {/* Tool Executions */}
      {toolExecutions.map((tool) => (
        <StreamingToolExecution key={tool.toolCallId} tool={tool} />
      ))}

      {/* Message Content */}
      {content && (
        <div className="flex gap-3 px-4 py-3 justify-start">
          <div className="flex-shrink-0 mt-0.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-4 w-4" />
            </div>
          </div>
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5">
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-foreground/70 animate-pulse ml-0.5" />
            )}
          </div>
        </div>
      )}

      {/* Loading indicator when no content yet */}
      {!content && isStreaming && toolExecutions.length === 0 && (
        <div className="flex gap-3 px-4 py-3 justify-start">
          <div className="flex-shrink-0 mt-0.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-4 w-4" />
            </div>
          </div>
          <div className="rounded-2xl bg-muted px-4 py-3">
            <div className="flex gap-1">
              <div className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <div className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <div className="w-2 h-2 bg-foreground/40 rounded-full animate-bounce" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StreamingToolExecution({ tool }: { tool: ToolExecution }) {
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";

  const argsPreview = useMemo(() => {
    try {
      const str =
        typeof tool.args === "string"
          ? tool.args
          : JSON.stringify(tool.args, null, 2);
      return str.length > 200 ? str.slice(0, 200) + "..." : str;
    } catch {
      return String(tool.args);
    }
  }, [tool.args]);

  return (
    <div className="flex gap-3 px-4 py-1.5 justify-start">
      <div className="w-8 flex-shrink-0" />
      <div
        className={cn(
          "max-w-[80%] rounded-lg border px-3 py-2 text-xs transition-all",
          isRunning && "border-primary/30 bg-primary/5 animate-pulse",
          isError && "border-destructive/30 bg-destructive/5",
          !isRunning && !isError && "border-border bg-card"
        )}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <Wrench
            className={cn(
              "h-3 w-3",
              isRunning && "text-primary animate-spin",
              isError && "text-destructive",
              !isRunning && !isError && "text-muted-foreground"
            )}
          />
          <Badge
            variant={
              isRunning ? "default" : isError ? "destructive" : "secondary"
            }
            className="text-[10px] px-1.5 py-0"
          >
            {tool.toolName}
          </Badge>
          {isRunning && (
            <span className="text-[10px] text-muted-foreground">
              running...
            </span>
          )}
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground overflow-x-auto">
          {argsPreview}
        </pre>
        {tool.result && (
          <>
            <div className="border-t my-1.5" />
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground overflow-x-auto max-h-32 overflow-y-auto">
              {tool.result.length > 500
                ? tool.result.slice(0, 500) + "..."
                : tool.result}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
