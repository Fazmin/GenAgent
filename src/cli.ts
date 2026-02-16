#!/usr/bin/env node
/**
 * Gen Agent CLI
 *
 * Event consumption:
 * - Uses agent.subscribe() to subscribe to typed events (aligned with pi-agent-core Agent.subscribe)
 * - Streaming text is output via message_delta events
 * - Tool/lifecycle events are handled via switch on event.type
 */

import "dotenv/config";
import readline from "node:readline";
import { Agent } from "./index.js";
import { resolveSessionKey } from "./session-key.js";
import { getEnvApiKey } from "@mariozechner/pi-ai";

// ============== Color output ==============

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function color(text: string, c: keyof typeof colors): string {
  return `${colors[c]}${text}${colors.reset}`;
}

let unsubscribe: (() => void) | null = null;

// ============== Main function ==============

async function main() {
  const args = process.argv.slice(2);
  const provider = readFlag(args, "--provider") ?? process.env.GEN_AGENT_PROVIDER ?? "anthropic";
  const model = readFlag(args, "--model");
  const apiKey = readFlag(args, "--api-key") ?? getEnvApiKey(provider);
  if (!apiKey) {
    console.error(`Error: API Key not found for ${provider}. Please set the corresponding environment variable or use the --api-key flag`);
    process.exit(1);
  }

  const agentId =
    readFlag(args, "--agent") ??
    process.env.GEN_AGENT_AGENT_ID ??
    "main";
  const sessionId = resolveSessionIdArg(args) || `session-${Date.now()}`;
  const workspaceDir = process.cwd();
  const sessionKey = resolveSessionKey({ agentId, sessionId });

  console.log(color("\n Gen Agent", "cyan"));
  console.log(color(`Provider: ${provider}${model ? ` (${model})` : ""}`, "dim"));
  console.log(color(`Session: ${sessionKey}`, "dim"));
  console.log(color(`Agent: ${agentId}`, "dim"));
  console.log(color(`Directory: ${workspaceDir}`, "dim"));
  console.log(color("Type /help for commands, Ctrl+C to exit\n", "dim"));

  const agent = new Agent({
    apiKey,
    provider,
    ...(model ? { model } : {}),
    agentId,
    workspaceDir,
  });

  // Event subscription (aligned with pi-agent-core: Agent.subscribe → typed event handling)
  unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      // Core lifecycle
      case "agent_start":
        console.error(color(`\n[event] run start id=${event.runId} model=${event.model}`, "magenta"));
        break;
      case "agent_end":
        console.error(color(`[event] run end id=${event.runId}\n`, "magenta"));
        break;
      case "agent_error":
        console.error(color(`[event] run error id=${event.runId} error=${event.error}\n`, "magenta"));
        break;

      // Streaming text output
      case "message_delta":
        process.stdout.write(event.delta);
        break;
      case "message_end":
        console.error(color(`[event] assistant final chars=${event.text.length}`, "magenta"));
        break;

      // Tool events
      case "tool_execution_start": {
        const input = safePreview(event.args, 120);
        console.error(color(`[event] tool start ${event.toolName}${input ? ` ${input}` : ""}`, "yellow"));
        break;
      }
      case "tool_execution_end":
        console.error(color(`[event] tool end ${event.toolName} ${event.result}`, "yellow"));
        break;
      case "tool_skipped":
        console.error(color(`[event] tool skipped ${event.toolName}`, "yellow"));
        break;

      // Compaction
      case "compaction":
        console.error(
          color(
            `[event] compaction summary_chars=${event.summaryChars} dropped_messages=${event.droppedMessages}`,
            "magenta",
          ),
        );
        break;

      // Sub-agent
      case "subagent_summary": {
        const label = event.label ? ` (${event.label})` : "";
        console.error(color(`\n[subagent${label}] ${event.summary}\n`, "cyan"));
        break;
      }
      case "subagent_error":
        console.error(color(`\n[subagent] error: ${event.error}\n`, "yellow"));
        break;
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(color("You: ", "green"), async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // Command handling
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, agent, sessionKey);
        prompt();
        return;
      }

      // Run Agent (streaming text output via subscribe's message_delta event)
      process.stdout.write(color("\nAgent: ", "blue"));

      try {
        const result = await agent.run(sessionKey, trimmed);

        const summaryParts = [
          `id=${result.runId ?? "unknown"}`,
          `turns=${result.turns}`,
          `tools=${result.toolCalls}`,
          typeof result.memoriesUsed === "number" ? `memories=${result.memoriesUsed}` : "",
          `chars=${result.text.length}`,
        ].filter(Boolean);
        console.log(color(`\n\n  [${summaryParts.join(", ")}]`, "dim"));
      } catch (err) {
        console.error(color(`\nError: ${(err as Error).message}`, "yellow"));
      }

      console.log();
      prompt();
    });
  };

  prompt();
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((arg) => arg === name);
  if (idx === -1) {
    return undefined;
  }
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) {
    return undefined;
  }
  return next.trim() || undefined;
}

function resolveSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "chat") {
      continue;
    }
    if (arg === "--agent") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    return arg.trim() || undefined;
  }
  return undefined;
}

function safePreview(input: unknown, max = 120): string {
  try {
    const text = JSON.stringify(input);
    if (!text) {
      return "";
    }
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return "";
  }
}

async function handleCommand(cmd: string, agent: Agent, sessionKey: string) {
  const [command] = cmd.slice(1).split(" ");

  switch (command) {
    case "help":
      console.log(`
Commands:
  /help     Show help
  /reset    Reset current session
  /history  Show session history
  /sessions List all sessions
  /quit     Exit
`);
      break;

    case "reset":
      await agent.reset(sessionKey);
      console.log(color("Session reset", "green"));
      break;

    case "history": {
      const history = agent.getHistory(sessionKey);
      if (history.length === 0) {
        console.log(color("No history", "dim"));
      } else {
        for (const msg of history) {
          const role = msg.role === "user" ? "You" : "Agent";
          const content =
            typeof msg.content === "string"
              ? msg.content
              : msg.content.map((c) => c.text || `[${c.type}]`).join(" ");
          console.log(`${color(role + ":", role === "You" ? "green" : "blue")} ${content.slice(0, 100)}...`);
        }
      }
      break;
    }

    case "sessions": {
      const sessions = await agent.listSessions();
      if (sessions.length === 0) {
        console.log(color("No sessions", "dim"));
      } else {
        console.log("Session list:");
        for (const s of sessions) {
          console.log(`  - ${s}${s === sessionKey ? color(" (current)", "cyan") : ""}`);
        }
      }
      break;
    }

    case "quit":
    case "exit":
      process.exit(0);

    default:
      console.log(color(`Unknown command: ${command}`, "yellow"));
  }
}

// Handle Ctrl+C
process.on("SIGINT", () => {
  console.log(color("\n\nGoodbye!", "cyan"));
  unsubscribe?.();
  process.exit(0);
});

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
