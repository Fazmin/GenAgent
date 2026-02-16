/**
 * Agent main loop
 *
 * Based on pi-agent-core → agent-loop.ts — runLoop()
 *
 * Pure function extracted from the Agent class: receives all dependencies, does not access Agent instance state.
 *
 * Architecture (EventStream pattern):
 * - Synchronously returns EventStream<MiniAgentEvent, MiniAgentResult>
 * - Internal IIFE executes the loop asynchronously, pushes typed events via stream.push()
 * - Consumer iterates the stream with for-await, or uses stream.result() for the final result
 *
 * Dual-loop structure:
 *
 * OUTER LOOP (follow-ups)
 * ├─ INNER LOOP (tools + steering)
 * │  ├─ Inject pendingMessages (steering or follow-up)
 * │  ├─ LLM streaming call
 * │  ├─ Execute tools (check steering after each execution)
 * │  ├─ If steering: skip remaining tools (each skipped tool gets a skipToolCall result)
 * │  └─ Loop condition: hasMoreToolCalls || pendingMessages.length > 0
 * ├─ Check follow-up messages
 * └─ If follow-up exists: continue outer loop
 */

import type { EventStream } from "@mariozechner/pi-ai";
import type { Tool, ToolContext } from "./tools/types.js";
import type { Message, ContentBlock } from "./session.js";
import type {
  Model,
  StreamFunction,
  SimpleStreamOptions,
  Context as PiContext,
} from "@mariozechner/pi-ai";
import {
  retryAsync,
  isContextOverflowError,
  isRateLimitError,
  describeError,
} from "./provider/errors.js";
import { pruneContextMessages } from "./context/index.js";
import { createMiniAgentStream, type MiniAgentEvent, type MiniAgentResult } from "./agent-events.js";
import { abortable } from "./tools/abort.js";
import { convertMessagesToPi } from "./message-convert.js";

// ============== Type definitions ==============

export interface AgentLoopParams {
  runId: string;
  sessionKey: string;
  agentId: string;
  /** Mutable: new messages are pushed during the loop */
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  toolsForRun: Tool[];
  toolCtx: ToolContext;
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  maxTurns: number;
  contextTokens: number;
  /**
   * Get steering messages
   *
   * Based on pi-agent-core → AgentLoopConfig.getSteeringMessages
   * - Called after each tool execution
   * - When a non-empty array is returned, remaining tools are skipped and injected into the next turn
   */
  getSteeringMessages: () => Promise<Message[]>;
  /**
   * Get follow-up messages
   *
   * Based on pi-agent-core → AgentLoopConfig.getFollowUpMessages
   * - Called after the inner loop ends (when the agent would otherwise stop)
   * - When a non-empty array is returned, the outer loop continues
   */
  getFollowUpMessages?: () => Promise<Message[]>;
  /** Persistence */
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  /** Compaction trigger */
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
  }>;
  /** External abort signal */
  abortSignal: AbortSignal;
}

// ============== skipToolCall ==============

/**
 * Generate a placeholder result for skipped tools
 *
 * Based on pi-agent-core → skipToolCall()
 * - isError: true, marked as an error result
 * - Message: "Skipped due to queued user message."
 * - Keeps the message structure intact for LLM context comprehension
 */
function skipToolCall(call: { id: string; name: string }): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    name: call.name,
    content: "Skipped due to queued user message.",
  };
}

// ============== Main loop ==============

/**
 * Agent main loop
 *
 * Based on pi-agent-core/agent-loop.js → agentLoop()
 * - Synchronously returns EventStream (IIFE pattern)
 * - Pushes typed events via stream.push()
 * - stream.end() is called on termination (agent_end / agent_error)
 */
export function runAgentLoop(params: AgentLoopParams): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();

  // Based on pi-agent-core: IIFE async execution loop, synchronously returns stream
  (async () => {
    const {
      runId,
      sessionKey,
      agentId,
      currentMessages,
      systemPrompt,
      toolsForRun,
      toolCtx,
      modelDef,
      streamFn,
      apiKey,
      temperature,
      maxTurns,
      contextTokens,
      getSteeringMessages,
      getFollowUpMessages,
      appendMessage,
      prepareCompaction,
      abortSignal,
    } = params;

    let { compactionSummary } = params;
    let turns = 0;
    let totalToolCalls = 0;
    let finalText = "";
    let overflowCompactionAttempted = false;

    try {
      // Check steering before the loop starts (user may have typed during the wait)
      let pendingMessages = await getSteeringMessages();

      // ========== Outer loop (follow-ups) ==========
      // Based on agent-loop.js outer while(true) loop
      outerLoop: while (true) {
        let hasMoreToolCalls = true;

        // ========== Inner loop (tools + steering) ==========
        // Based on inner while (hasMoreToolCalls || pendingMessages.length > 0)
        while (hasMoreToolCalls || pendingMessages.length > 0) {
          if (turns >= maxTurns) break outerLoop;
          if (abortSignal.aborted) break outerLoop;

          turns++;
          stream.push({ type: "turn_start", turn: turns });

          // Inject pending messages (steering or follow-up)
          if (pendingMessages.length > 0) {
            for (const msg of pendingMessages) {
              await appendMessage(sessionKey, msg);
              currentMessages.push(msg);
            }
            pendingMessages = [];
          }

          // ===== Prune: executed every turn =====
          const pruneResult = pruneContextMessages({
            messages: currentMessages,
            contextWindowTokens: contextTokens,
          });
          let messagesForModel = pruneResult.messages;
          if (compactionSummary) {
            messagesForModel = [compactionSummary, ...messagesForModel];
          }

          // Build pi-ai Context
          const piContext: PiContext = {
            systemPrompt,
            messages: convertMessagesToPi(messagesForModel, modelDef),
            tools: toolsForRun.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as any,
            })),
          };

          // ===== LLM call with retry =====
          const assistantContent: ContentBlock[] = [];
          const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          const turnTextParts: string[] = [];

          try {
            await retryAsync(
              async () => {
                assistantContent.length = 0;
                toolCalls.length = 0;
                turnTextParts.length = 0;

                const streamOpts: SimpleStreamOptions = {
                  maxTokens: modelDef.maxTokens,
                  signal: abortSignal,
                  apiKey,
                  ...(temperature !== undefined ? { temperature } : {}),
                };
                const eventStream = streamFn(modelDef, piContext, streamOpts);

                for await (const event of eventStream) {
                  if (abortSignal.aborted) break;

                  switch (event.type) {
                    case "text_delta":
                      stream.push({ type: "message_delta", delta: event.delta });
                      break;

                    case "text_end":
                      turnTextParts.push(event.content);
                      assistantContent.push({ type: "text", text: event.content });
                      break;

                    case "toolcall_start":
                      break;

                    case "toolcall_end": {
                      const tc = event.toolCall;
                      const tcArgs = tc.arguments as Record<string, unknown>;
                      assistantContent.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.name,
                        input: tcArgs,
                      });
                      toolCalls.push({
                        id: tc.id,
                        name: tc.name,
                        input: tcArgs,
                      });
                      break;
                    }
                  }
                }

                const result = eventStream.result();
                await abortable(result, abortSignal);
              },
              {
                attempts: 3,
                minDelayMs: 300,
                maxDelayMs: 30_000,
                jitter: 0.1,
                label: "llm-call",
                shouldRetry: (err) => {
                  if (abortSignal.aborted) return false;
                  return isRateLimitError(describeError(err));
                },
                onRetry: ({ attempt, delay, error }) => {
                  stream.push({ type: "retry", attempt, delay, error: describeError(error) });
                },
              },
            );
          } catch (llmError) {
            // Context overflow → auto-compact → retry once
            const errorText = describeError(llmError);
            if (isContextOverflowError(errorText) && !overflowCompactionAttempted) {
              overflowCompactionAttempted = true;
              stream.push({ type: "context_overflow_compact", error: errorText });
              const overflowPrep = await prepareCompaction({
                messages: currentMessages,
                sessionKey,
                runId,
              });
              if (overflowPrep.summary && overflowPrep.summaryMessage) {
                compactionSummary = overflowPrep.summaryMessage;
                turns--;
                continue;
              }
            }
            throw llmError;
          }

          // Save assistant message
          const assistantMsg: Message = {
            role: "assistant",
            content: assistantContent,
            timestamp: Date.now(),
          };
          await appendMessage(sessionKey, assistantMsg);
          currentMessages.push(assistantMsg);

          const turnText = turnTextParts.join("");
          if (turnText) {
            stream.push({ type: "message_end", message: assistantMsg, text: turnText });
          }

          hasMoreToolCalls = toolCalls.length > 0;

          // No tool calls → one of the inner loop exit conditions
          if (!hasMoreToolCalls) {
            finalText = turnText;
            stream.push({ type: "turn_end", turn: turns });
            // Check if there are pending steering messages
            pendingMessages = await getSteeringMessages();
            continue;
          }

          // ===== Execute tools (serial + steering interrupt detection) =====
          // Based on executeToolCalls() + getSteeringMessages check
          const toolResults: ContentBlock[] = [];
          let steeringMessages: Message[] | null = null;

          for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i];
            const tool = toolsForRun.find((t) => t.name === call.name);
            let result: string;

            stream.push({
              type: "tool_execution_start",
              toolCallId: call.id,
              toolName: call.name,
              args: call.input,
            });

            if (tool) {
              try {
                result = await tool.execute(call.input, toolCtx);
              } catch (err) {
                result = `Execution error: ${(err as Error).message}`;
              }
            } else {
              result = `Unknown tool: ${call.name}`;
            }

            totalToolCalls++;
            const isError = !tool;
            stream.push({
              type: "tool_execution_end",
              toolCallId: call.id,
              toolName: call.name,
              result: result.length > 500 ? `${result.slice(0, 500)}...` : result,
              isError,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              name: call.name,
              content: result,
            });

            // Check steering after each tool execution
            const steering = await getSteeringMessages();
            if (steering.length > 0) {
              steeringMessages = steering;
              // skipToolCall() — skip remaining tools
              const remaining = toolCalls.slice(i + 1);
              for (const skipped of remaining) {
                stream.push({
                  type: "tool_skipped",
                  toolCallId: skipped.id,
                  toolName: skipped.name,
                });
                toolResults.push(skipToolCall(skipped));
              }
              stream.push({ type: "steering", pendingCount: steering.length });
              break;
            }
          }

          // Add tool results (including skip results)
          const resultMsg: Message = {
            role: "user",
            content: toolResults,
            timestamp: Date.now(),
          };
          await appendMessage(sessionKey, resultMsg);
          currentMessages.push(resultMsg);

          stream.push({ type: "turn_end", turn: turns });

          // Steering messages set as pendingMessages, injected in the next turn
          if (steeringMessages && steeringMessages.length > 0) {
            pendingMessages = steeringMessages;
          } else {
            pendingMessages = await getSteeringMessages();
          }
        }
        // ========== Inner loop end ==========

        // Check follow-up messages
        if (getFollowUpMessages) {
          const followUp = await getFollowUpMessages();
          if (followUp.length > 0) {
            pendingMessages = followUp;
            continue;
          }
        }
        break;
      }
      // ========== Outer loop end ==========

      stream.push({ type: "agent_end", runId, messages: currentMessages });
      stream.end({ finalText, turns, totalToolCalls, messages: currentMessages });
    } catch (err) {
      stream.push({ type: "agent_error", runId, error: describeError(err) });
      stream.end({ finalText, turns, totalToolCalls, messages: currentMessages });
    }
  })();

  return stream;
}
