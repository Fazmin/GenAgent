import { createCompactionSummaryMessage, type Message } from "../session.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./tokens.js";
import {
  pruneContextMessages,
  type ContextPruningSettings,
  type PruneResult,
} from "./pruning.js";

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;

/**
 * Compaction Settings
 */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 20_000,
};

export const DEFAULT_SUMMARY_MAX_TOKENS = 900;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into one coherent summary. Preserve key decisions, TODOs, unresolved issues, and constraints.";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then output a structured summary in the specified format.

Do not continue the conversation. Do not answer questions from the conversation. Only output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation. Please generate a structured context checkpoint summary for subsequent models to continue working with.

Please strictly use the following format:

## Goals
[What does the user want to accomplish? If the session involves multiple tasks, list multiple goals]

## Constraints and Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [If none, write "(none)"]

## Progress
### Completed
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work in progress]

### Blocked
- [If there are blocking issues, write them here]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [List next steps in order]

## Key Information
- [Any data, examples, or references needed to continue work]
- [If not applicable, write "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are new conversation content that needs to be incorporated into an existing summary. The existing summary is in the <previous-summary> tag.

Please update the existing summary while preserving its information. Rules:
- Preserve all important information from the existing summary
- Append new progress, decisions, and context
- Update "Progress": move completed items from "In Progress" to "Completed"
- Update "Next Steps" based on new progress
- Preserve exact file paths, function names, and error messages
- If some information is no longer relevant, it may be removed

Please strictly use the following format:

## Goals
[Preserve existing goals, supplement with new ones if necessary]

## Constraints and Preferences
- [Preserve existing content, add newly discovered content]

## Progress
### Completed
- [x] [Include previously completed items + newly completed items]

### In Progress
- [ ] [Current work in progress]

### Blocked
- [Current blocking issues; remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve existing and supplement with new ones)

## Next Steps
1. [Update next steps based on current state]

## Key Information
- [Preserve important context, supplement with new information if necessary]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

type FileOps = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
};

function createFileOps(): FileOps {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

function extractFileOpsFromMessage(message: Message, fileOps: FileOps): void {
  if (message.role !== "assistant") {
    return;
  }
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const args = block.input;
    if (!args || typeof args !== "object") {
      continue;
    }
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Summary generation function signature
 *
 * Decouples compaction from specific LLM SDK:
 * - Caller implements via pi-ai's completeSimple or any provider
 */
export type SummarizeFn = (params: {
  system: string;
  userPrompt: string;
  maxTokens: number;
}) => Promise<string>;

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function computeAdaptiveChunkRatio(messages: Message[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

export function splitMessagesByTokenShare(messages: Message[], parts = DEFAULT_PARTS): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMessagesByMaxTokens(messages: Message[], maxTokens: number): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (current.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;

    if (messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function isOversizedForSummary(msg: Message, contextWindow: number): boolean {
  const tokens = estimateMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

function extractUserText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text) {
        parts.push(`[User]: ${text}`);
      }
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content
          .filter((block) => block.type === "tool_result")
          .map((block) => block.content ?? "")
          .filter(Boolean);
        for (const result of toolResults) {
          parts.push(`[Tool result]: ${result}`);
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            if (block.text) {
              textParts.push(block.text);
            }
            continue;
          }
          if (block.type === "tool_use") {
            const args = block.input ?? {};
            const argsStr = Object.entries(args)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(", ");
            toolCalls.push(`${block.name ?? "tool"}(${argsStr})`);
          }
        }
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    }
  }
  return parts.join("\n\n");
}

async function generateSummary(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  let basePrompt = params.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (params.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${params.customInstructions}`;
  }
  const conversationText = serializeConversation(params.messages);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (params.previousSummary) {
    prompt += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += basePrompt;

  return params.summarize({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: params.maxTokens,
  });
}

async function summarizeChunks(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  let summary = params.previousSummary;
  for (const chunk of chunks) {
    summary = await generateSummary({
      messages: chunk,
      summarize: params.summarize,
      maxTokens: params.maxTokens,
      customInstructions: params.customInstructions,
      previousSummary: summary,
    });
  }
  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

async function summarizeWithFallback(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  try {
    return await summarizeChunks(params);
  } catch {
    // fallback
  }

  const smallMessages: Message[] = [];
  const oversizedNotes: string[] = [];
  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      const tokens = estimateMessageTokens(msg);
      oversizedNotes.push(`[Large ${msg.role} (~${Math.round(tokens / 1000)}K tokens) omitted]`);
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partial = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partial + notes;
    } catch {
      // fall through
    }
  }

  return `Context contained ${params.messages.length} messages. Summary unavailable due to size limits.`;
}

export async function summarizeInStages(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: Message[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

/**
 * Whether compaction should be triggered
 *
 * Trigger condition: contextTokens > contextWindow - reserveTokens
 * (reserve-based, not ratio-based)
 */
export function shouldTriggerCompaction(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
}): boolean {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...params.settings,
  };
  if (!settings.enabled) return false;
  const totalTokens = estimateMessagesTokens(params.messages);
  return totalTokens > params.contextWindowTokens - settings.reserveTokens;
}

/**
 * Generate compaction summary
 *
 * maxTokens = floor(0.8 x reserveTokens)
 */
export async function buildCompactionSummary(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens?: number;
  customInstructions?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return DEFAULT_SUMMARY_FALLBACK;
  }
  const adaptiveRatio = computeAdaptiveChunkRatio(params.messages, params.contextWindowTokens);
  const maxChunkTokens = Math.max(1, Math.floor(params.contextWindowTokens * adaptiveRatio));
  const reserveTokens = params.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxTokens = Math.max(64, Math.floor(params.maxTokens ?? (0.8 * reserveTokens)));

  return summarizeInStages({
    messages: params.messages,
    summarize: params.summarize,
    maxTokens,
    maxChunkTokens,
    contextWindow: params.contextWindowTokens,
    customInstructions: params.customInstructions,
  });
}

export async function compactHistoryIfNeeded(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactionSettings?: Partial<CompactionSettings>;
  maxTokens?: number;
}): Promise<{
  summary?: string;
  summaryMessage?: Message;
  pruneResult: PruneResult;
}> {
  const pruneResult = pruneContextMessages({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    settings: params.pruningSettings,
  });

  const shouldCompact = shouldTriggerCompaction({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    settings: params.compactionSettings,
  });

  if (!shouldCompact || pruneResult.droppedMessages.length === 0) {
    return { pruneResult };
  }

  const resolvedSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.compactionSettings };
  let summary = await buildCompactionSummary({
    summarize: params.summarize,
    messages: pruneResult.droppedMessages,
    contextWindowTokens: params.contextWindowTokens,
    maxTokens: params.maxTokens,
    reserveTokens: resolvedSettings.reserveTokens,
  });
  const fileOps = createFileOps();
  for (const message of pruneResult.droppedMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  const summaryMessage: Message = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    pruneResult,
  };
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_HISTORY_SHARE = 0.5;
export const DEFAULT_CONTEXT_WINDOW_CHARS =
  DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
