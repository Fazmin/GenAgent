"use client";

import { useState, useEffect, useCallback } from "react";
import { ChatSidebar } from "./chat-sidebar";
import { ChatArea } from "./chat-area";
import { SettingsDialog } from "./settings-dialog";
import { useChat } from "@/hooks/use-chat";
import type { Conversation } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

export function ChatLayout() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

  const {
    messages,
    streamingMessage,
    isLoading,
    loadMessages,
    sendMessage,
    stopGeneration,
    clearMessages,
  } = useChat(activeConversationId);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (error) {
      console.error("Failed to fetch conversations:", error);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId);
    } else {
      clearMessages();
    }
  }, [activeConversationId, loadMessages, clearMessages]);

  const handleNewConversation = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const conv = await res.json();
        setConversations((prev) => [conv, ...prev]);
        setActiveConversationId(conv.id);
        setSidebarOpen(false);
      }
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (activeConversationId === id) {
            setActiveConversationId(null);
          }
        }
      } catch (error) {
        console.error("Failed to delete conversation:", error);
      }
    },
    [activeConversationId]
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (res.ok) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title } : c))
          );
        }
      } catch (error) {
        console.error("Failed to rename conversation:", error);
      }
    },
    []
  );

  const handleSendMessage = useCallback(
    async (message: string) => {
      let convId = activeConversationId;

      if (!convId) {
        try {
          const res = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title:
                message.length > 50
                  ? message.substring(0, 50) + "..."
                  : message,
            }),
          });
          if (res.ok) {
            const conv = await res.json();
            setConversations((prev) => [conv, ...prev]);
            setActiveConversationId(conv.id);
            convId = conv.id;
          }
        } catch (error) {
          console.error("Failed to create conversation:", error);
          return;
        }
      }

      if (convId) {
        sendMessage(message);
        // Refresh conversations to get updated titles
        setTimeout(fetchConversations, 2000);
      }
    },
    [activeConversationId, sendMessage, fetchConversations]
  );

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setSidebarOpen(false);
  }, []);

  const sidebarContent = (
    <ChatSidebar
      conversations={conversations}
      activeConversationId={activeConversationId}
      onSelectConversation={handleSelectConversation}
      onNewConversation={handleNewConversation}
      onDeleteConversation={handleDeleteConversation}
      onRenameConversation={handleRenameConversation}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      {!isMobile && sidebarContent}

      {/* Mobile Sidebar */}
      {isMobile && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="fixed top-3 left-3 z-50 h-9 w-9 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-64">
            {sidebarContent}
          </SheetContent>
        </Sheet>
      )}

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header */}
        {isMobile && (
          <div className="flex items-center border-b px-4 py-3 pl-14">
            <span className="text-sm font-medium truncate">
              {conversations.find((c) => c.id === activeConversationId)
                ?.title || "oneAgent"}
            </span>
          </div>
        )}

        <ChatArea
          conversationId={activeConversationId}
          messages={messages}
          streamingMessage={streamingMessage}
          isLoading={isLoading}
          onSend={handleSendMessage}
          onStop={stopGeneration}
        />
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
