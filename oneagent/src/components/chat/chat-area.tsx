"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble, StreamingMessageBubble } from "./message-bubble";
import { ChatInput } from "./chat-input";
import { Bot, Sparkles, Terminal, Brain, FolderSearch } from "lucide-react";
import type { Message, StreamingMessage } from "@/lib/types";

interface ChatAreaProps {
  conversationId: string | null;
  messages: Message[];
  streamingMessage: StreamingMessage | null;
  isLoading: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
}

export function ChatArea({
  conversationId,
  messages,
  streamingMessage,
  isLoading,
  onSend,
  onStop,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMessage?.content, streamingMessage?.toolExecutions]);

  if (!conversationId) {
    return <EmptyState onSend={onSend} />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl py-4">
          {messages.length === 0 && !streamingMessage && !isLoading && (
            <EmptyConversation />
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {streamingMessage && (
            <StreamingMessageBubble
              content={streamingMessage.content}
              toolExecutions={streamingMessage.toolExecutions}
              isStreaming={streamingMessage.isStreaming}
            />
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <ChatInput
        onSend={onSend}
        onStop={onStop}
        isLoading={isLoading}
        disabled={!conversationId}
      />
    </div>
  );
}

function EmptyState({ onSend }: { onSend: (message: string) => void }) {
  const suggestions = [
    {
      icon: Terminal,
      title: "Run a command",
      description: "List all files in the current directory",
      message: "List all files in the current directory",
    },
    {
      icon: FolderSearch,
      title: "Search code",
      description: "Find all TypeScript files that export a class",
      message: "Search for all TypeScript files that export a class in this project",
    },
    {
      icon: Brain,
      title: "Explain code",
      description: "How does the agent loop work?",
      message: "Explain how the agent loop works in this codebase",
    },
    {
      icon: Sparkles,
      title: "Write code",
      description: "Create a utility function",
      message: "Create a TypeScript utility function that formats a date relative to now (e.g. '2 hours ago')",
    },
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Bot className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold">oneAgent</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-md">
          An AI assistant powered by GenAgent. It can read files, execute
          commands, search code, and help you build software.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl w-full">
        {suggestions.map((s) => (
          <button
            key={s.title}
            onClick={() => onSend(s.message)}
            className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent group"
          >
            <s.icon className="h-5 w-5 mt-0.5 text-muted-foreground group-hover:text-primary transition-colors" />
            <div>
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {s.description}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
        <Bot className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">Start a conversation</p>
      <p className="text-xs text-muted-foreground mt-1">
        Type a message below to begin chatting with the agent.
      </p>
    </div>
  );
}
