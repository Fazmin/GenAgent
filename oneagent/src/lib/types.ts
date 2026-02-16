export interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  is_error: number;
  created_at: string;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "completed" | "error";
}

export interface StreamingMessage {
  id: string;
  role: "assistant";
  content: string;
  isStreaming: boolean;
  toolExecutions: ToolExecution[];
}

export interface Settings {
  provider: string;
  model: string;
  apiKey: string;
  enableMemory: string;
  enableContext: string;
  enableSkills: string;
  maxTurns: string;
}

export const PROVIDERS = [
  { value: "anthropic", label: "Anthropic", models: ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"] },
  { value: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"] },
  { value: "google", label: "Google", models: ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"] },
  { value: "groq", label: "Groq", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"] },
] as const;

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-4-20250514";
