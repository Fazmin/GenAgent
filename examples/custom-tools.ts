/**
 * Custom tools example
 *
 * Event consumption: agent.subscribe() subscribes to typed events
 */

import { Agent, builtinTools, type Tool } from "../src/index.js";

// Custom tool: Get current time
const timeTool: Tool<{ timezone?: string }> = {
  name: "get_time",
  description: "Get the current time",
  inputSchema: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "Timezone, e.g. America/New_York" },
    },
  },
  async execute(input) {
    const tz = input.timezone ?? "UTC";
    const now = new Date().toLocaleString("en-US", { timeZone: tz });
    return `Current time (${tz}): ${now}`;
  },
};

// Custom tool: Calculator
const calcTool: Tool<{ expression: string }> = {
  name: "calculate",
  description: "Evaluate a mathematical expression",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression, e.g. 2 + 3 * 4" },
    },
    required: ["expression"],
  },
  async execute(input) {
    try {
      // Simple safety check
      if (!/^[\d\s+\-*/().]+$/.test(input.expression)) {
        return "Error: Unsupported expression";
      }
      const result = Function(`"use strict"; return (${input.expression})`)();
      return `${input.expression} = ${result}`;
    } catch (err) {
      return `Calculation error: ${(err as Error).message}`;
    }
  },
};

async function main() {
  const agent = new Agent({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    // Combine built-in tools with custom tools
    tools: [...builtinTools, timeTool, calcTool],
    systemPrompt: `You are an assistant with the following tools available:
- read/write/edit: File operations
- exec: Execute commands
- get_time: Get current time
- calculate: Evaluate math expressions

Help the user complete their tasks.`,
  });

  console.log("Custom Tools Example\n");

  // Subscribe to events (streaming text + tool call details)
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "message_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_execution_start":
        console.log(`\n[${event.toolName}]`, event.args);
        break;
      case "tool_execution_end":
        console.log(`  -> ${event.result}`);
        break;
    }
  });

  const result = await agent.run(
    "custom-tools",
    "What time is it? Also, calculate (15 + 27) * 3 for me.",
  );

  console.log(`\n\nDone: ${result.turns} turns, ${result.toolCalls} tool calls`);

  unsubscribe();
}

main().catch(console.error);
