/**
 * Provider Abstraction Layer — based on @mariozechner/pi-ai
 *
 * Design decisions:
 * - LLM SDK adaptation (Anthropic/OpenAI/Gemini) is delegated to pi-ai
 * - The Agent layer only depends on pi-ai's unified interface: StreamFunction, Model, Context, AssistantMessageEvent
 * - Error classification and retry are Agent-layer logic, kept in errors.ts
 */

// pi-ai core types
export type {
  Api,
  KnownApi,
  Provider,
  KnownProvider,
  Model,
  StreamFunction,
  StreamOptions,
  SimpleStreamOptions,
  Context,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
  StopReason,
  ThinkingLevel,
  Message as PiMessage,
  UserMessage as PiUserMessage,
  ToolResultMessage as PiToolResultMessage,
  Tool as PiTool,
} from "@mariozechner/pi-ai";

// pi-ai streaming calls
export {
  stream,
  streamSimple,
  complete,
  completeSimple,
} from "@mariozechner/pi-ai";

// pi-ai provider adapters
export { streamAnthropic, streamSimpleAnthropic } from "@mariozechner/pi-ai";

// pi-ai model registry
export { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

// pi-ai EventStream
export {
  createAssistantMessageEventStream,
  type EventStream,
  AssistantMessageEventStream as AssistantMessageEventStreamClass,
} from "@mariozechner/pi-ai";

// pi-ai context overflow detection
export { isContextOverflow } from "@mariozechner/pi-ai";

// Agent layer: error classification and retry (not included in pi-ai)
export {
  FailoverError,
  isFailoverError,
  type FailoverReason,
  type RetryOptions,
  retryAsync,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isAuthError,
  classifyFailoverReason,
  describeError,
} from "./errors.js";
