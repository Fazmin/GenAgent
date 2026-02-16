/**
 * Context Pruning
 *
 * Three-layer progressive pruning strategy:
 *
 * Layer 1: Soft Trim (tool result content truncation)
 *   Trigger: ratio exceeds softTrimRatio (default 0.3)
 *   Action: keep head + tail of prunable tool results, discard middle
 *
 * Layer 2: Hard Clear (tool result content clearing)
 *   Trigger: ratio still exceeds hardClearRatio (default 0.5) after soft trim
 *   Prerequisite: prunable tool result total chars > minPrunableToolChars
 *   Action: replace tool result content with placeholder "[Old tool result content cleared]"
 *
 * Layer 3: Message Drop (message-level discard)
 *   Trigger: total chars exceed history budget
 *   Action: drop whole messages from oldest to newest, protect the most recent N assistant messages
 */

import type { ContentBlock, Message } from "../session.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateMessagesChars,
} from "./tokens.js";

// ============== Tool Prunability Determination ==============

/**
 * Tool Pruning Rules
 *
 * When allow is empty, all non-denied tools are prunable
 */
export type ContextPruningToolMatch = {
  /** Allowlist (glob-style, e.g. ["exec", "file_*"]). Empty array = all prunable */
  allow?: string[];
  /** Denylist (higher priority than allow) */
  deny?: string[];
};

/**
 * Build tool prunability predicate
 *
 * Logic: deny takes priority → empty allow means all allowed → otherwise match allow
 */
function makeToolPrunablePredicate(
  match?: ContextPruningToolMatch,
): (toolName: string) => boolean {
  if (!match) return () => true;

  const deny = match.deny ?? [];
  const allow = match.allow ?? [];

  return (toolName: string) => {
    const normalized = toolName.trim().toLowerCase();
    if (deny.some((pattern) => matchGlob(normalized, pattern.toLowerCase()))) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return allow.some((pattern) => matchGlob(normalized, pattern.toLowerCase()));
  };
}

/** Simple glob matching (supports only * wildcard) */
function matchGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`,
  );
  return regex.test(value);
}

// ============== Settings ==============

export type ContextPruningSettings = {
  /** Maximum ratio of history messages to context window (message-level drop budget) */
  maxHistoryShare: number;
  /** Protect the most recent N assistant messages from being dropped */
  keepLastAssistants: number;
  /** Ratio threshold that triggers soft trim */
  softTrimRatio: number;
  /** Ratio threshold that triggers hard clear */
  hardClearRatio: number;
  /** Minimum prunable chars to trigger hard clear */
  minPrunableToolChars: number;
  /** Soft trim parameters */
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  /** Hard clear parameters */
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
  /** Tool prunability rules */
  tools: ContextPruningToolMatch;
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: ContextPruningSettings = {
  maxHistoryShare: 0.5,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
  tools: {},
};

export type PruneResult = {
  messages: Message[];
  droppedMessages: Message[];
  trimmedToolResults: number;
  hardClearedToolResults: number;
  totalChars: number;
  keptChars: number;
  droppedChars: number;
  budgetChars: number;
};

function clampShare(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function resolvePruningSettings(
  raw?: Partial<ContextPruningSettings>,
): ContextPruningSettings {
  if (!raw) return DEFAULT_CONTEXT_PRUNING_SETTINGS;
  const d = DEFAULT_CONTEXT_PRUNING_SETTINGS;
  return {
    maxHistoryShare: clampShare(raw.maxHistoryShare ?? d.maxHistoryShare, d.maxHistoryShare),
    keepLastAssistants: clampPositiveInt(raw.keepLastAssistants, d.keepLastAssistants),
    softTrimRatio: clampShare(raw.softTrimRatio ?? d.softTrimRatio, d.softTrimRatio),
    hardClearRatio: clampShare(raw.hardClearRatio ?? d.hardClearRatio, d.hardClearRatio),
    minPrunableToolChars: clampPositiveInt(raw.minPrunableToolChars, d.minPrunableToolChars),
    softTrim: {
      maxChars: clampPositiveInt(raw.softTrim?.maxChars, d.softTrim.maxChars),
      headChars: clampPositiveInt(raw.softTrim?.headChars, d.softTrim.headChars),
      tailChars: clampPositiveInt(raw.softTrim?.tailChars, d.softTrim.tailChars),
    },
    hardClear: {
      enabled: raw.hardClear?.enabled ?? d.hardClear.enabled,
      placeholder: raw.hardClear?.placeholder ?? d.hardClear.placeholder,
    },
    tools: raw.tools ?? d.tools,
  };
}

// ============== Layer 1: Soft Trim ==============

function cloneMessage(message: Message, content: Message["content"]): Message {
  return { ...message, content };
}

/**
 * Check if a tool_result block contains non-prunable content
 *
 * Gen Agent's ContentBlock doesn't support image type yet; this check is reserved for extension
 */
function isToolResultProtected(_block: ContentBlock): boolean {
  return false;
}

/**
 * Perform soft trim on a single tool_result block
 *
 * Keep head + tail, discard middle, add explanation
 */
function softTrimToolResultBlock(
  block: ContentBlock,
  settings: ContextPruningSettings["softTrim"],
  isPrunable: (toolName: string) => boolean,
): { block: ContentBlock; trimmed: boolean } {
  if (block.type !== "tool_result") {
    return { block, trimmed: false };
  }

  // Protected tool results are not trimmed
  if (isToolResultProtected(block)) {
    return { block, trimmed: false };
  }

  // Tool prunability check
  if (block.tool_use_id && !isPrunable(block.tool_use_id)) {
    return { block, trimmed: false };
  }

  const raw = typeof block.content === "string" ? block.content : "";
  const rawLen = raw.length;
  if (rawLen <= settings.maxChars) {
    return { block, trimmed: false };
  }

  const headChars = Math.max(0, settings.headChars);
  const tailChars = Math.max(0, settings.tailChars);
  if (headChars + tailChars >= rawLen) {
    return { block, trimmed: false };
  }

  const head = raw.slice(0, headChars);
  const tail = raw.slice(rawLen - tailChars);
  const trimmedText =
    `${head}\n...\n${tail}\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return {
    block: { ...block, content: trimmedText },
    trimmed: true,
  };
}

function applySoftTrim(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
): { messages: Message[]; trimmedToolResults: number } {
  let trimmedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      const result = softTrimToolResultBlock(block, settings.softTrim, isPrunable);
      if (result.trimmed) {
        trimmedToolResults += 1;
        didChange = true;
      }
      nextBlocks.push(result.block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, trimmedToolResults };
}

// ============== Layer 2: Hard Clear ==============

/**
 * Count total chars of prunable tool results
 */
function countPrunableToolChars(
  messages: Message[],
  isPrunable: (toolName: string) => boolean,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (isToolResultProtected(block)) continue;
      if (block.tool_use_id && !isPrunable(block.tool_use_id)) continue;
      const text = typeof block.content === "string" ? block.content : "";
      total += text.length;
    }
  }
  return total;
}

/**
 * Perform hard clear on prunable tool results
 *
 * Replace content with placeholder, preserving message structure and toolCallId (for debug tracing)
 */
function applyHardClear(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
  charWindow: number,
): { messages: Message[]; hardClearedToolResults: number } {
  if (!settings.hardClear.enabled) {
    return { messages, hardClearedToolResults: 0 };
  }

  let totalChars = estimateMessagesChars(messages);
  const ratio = totalChars / charWindow;

  // Only trigger when exceeding hardClearRatio
  if (ratio < settings.hardClearRatio) {
    return { messages, hardClearedToolResults: 0 };
  }

  // Don't trigger if prunable chars are insufficient
  const prunableChars = countPrunableToolChars(messages, isPrunable);
  if (prunableChars < settings.minPrunableToolChars) {
    return { messages, hardClearedToolResults: 0 };
  }

  let hardClearedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];

    for (const block of msg.content) {
      // Only clear prunable tool_results (non-image)
      if (
        block.type === "tool_result" &&
        !isToolResultProtected(block) &&
        typeof block.content === "string" &&
        block.content.length > 0
      ) {
        const canPrune = !block.tool_use_id || isPrunable(block.tool_use_id);

        if (canPrune) {
          // Stop when ratio has dropped below threshold
          const currentRatio = totalChars / charWindow;
          if (currentRatio < settings.hardClearRatio) {
            nextBlocks.push(block);
            continue;
          }

          const beforeLen = block.content.length;
          const clearedBlock: ContentBlock = {
            ...block,
            content: settings.hardClear.placeholder,
          };
          nextBlocks.push(clearedBlock);
          totalChars -= beforeLen - settings.hardClear.placeholder.length;
          hardClearedToolResults += 1;
          didChange = true;
          continue;
        }
      }

      nextBlocks.push(block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, hardClearedToolResults };
}

// ============== Layer 3: Message Drop ==============

/**
 * Find assistant cutoff protection boundary
 *
 * Count backwards from the end, protecting the most recent N assistant messages and everything after them
 */
function findAssistantCutoffIndex(messages: Message[], keepLastAssistants: number): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    remaining -= 1;
    if (remaining === 0) return i;
  }
  return null;
}

/**
 * Fill budget from the end backwards
 *
 * Keep as many recent messages as possible until budget is exceeded
 */
function sliceWithinBudget(messages: Message[], budgetChars: number): Message[] {
  const kept: Message[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = estimateMessageChars(msg);
    if (used + chars > budgetChars && kept.length > 0) break;
    kept.push(msg);
    used += chars;
  }
  kept.reverse();
  return kept;
}

// ============== Main Entry ==============

/**
 * Three-layer progressive context pruning
 *
 * Execution order: soft trim → hard clear → message drop
 */
export function pruneContextMessages(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<ContextPruningSettings>;
}): PruneResult {
  const settings = resolvePruningSettings(params.settings);
  const contextTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const charWindow = contextTokens * CHARS_PER_TOKEN_ESTIMATE;
  const budgetChars = Math.max(1, Math.floor(charWindow * settings.maxHistoryShare));
  const isPrunable = makeToolPrunablePredicate(settings.tools);

  let current = params.messages;
  let trimmedToolResults = 0;
  let hardClearedToolResults = 0;

  // Layer 1: Soft Trim — triggers when ratio exceeds softTrimRatio
  const totalChars = estimateMessagesChars(current);
  const ratio = totalChars / charWindow;
  if (ratio > settings.softTrimRatio) {
    const trimResult = applySoftTrim(current, settings, isPrunable);
    current = trimResult.messages;
    trimmedToolResults = trimResult.trimmedToolResults;
  }

  // Layer 2: Hard Clear — triggers when still over threshold after soft trim
  const afterSoftTrimChars = estimateMessagesChars(current);
  const afterSoftTrimRatio = afterSoftTrimChars / charWindow;
  if (afterSoftTrimRatio > settings.hardClearRatio) {
    const clearResult = applyHardClear(current, settings, isPrunable, charWindow);
    current = clearResult.messages;
    hardClearedToolResults = clearResult.hardClearedToolResults;
  }

  // Layer 3: Message Drop — drops old messages when exceeding history budget
  const afterClearChars = estimateMessagesChars(current);
  if (afterClearChars <= budgetChars) {
    return {
      messages: current,
      droppedMessages: [],
      trimmedToolResults,
      hardClearedToolResults,
      totalChars: afterClearChars,
      keptChars: afterClearChars,
      droppedChars: 0,
      budgetChars,
    };
  }

  const cutoffIndex = findAssistantCutoffIndex(current, settings.keepLastAssistants);
  const protectedIndex = cutoffIndex ?? 0;
  const protectedMessages = current.slice(protectedIndex);
  const protectedChars = estimateMessagesChars(protectedMessages);

  let kept: Message[];
  if (protectedChars > budgetChars) {
    kept = sliceWithinBudget(current, budgetChars);
  } else {
    kept = [...protectedMessages];
    let remaining = budgetChars - protectedChars;
    for (let i = protectedIndex - 1; i >= 0; i--) {
      const msg = current[i];
      const msgChars = estimateMessageChars(msg);
      if (msgChars > remaining) break;
      kept.unshift(msg);
      remaining -= msgChars;
    }
  }

  const keptSet = new Set(kept);
  const droppedMessages = current.filter((msg) => !keptSet.has(msg));
  const keptChars = estimateMessagesChars(kept);
  const droppedChars = Math.max(0, afterClearChars - keptChars);

  return {
    messages: kept,
    droppedMessages,
    trimmedToolResults,
    hardClearedToolResults,
    totalChars: afterClearChars,
    keptChars,
    droppedChars,
    budgetChars,
  };
}
