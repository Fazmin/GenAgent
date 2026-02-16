/**
 * Basic usage example
 *
 * Event consumption: agent.subscribe() subscribes to typed events
 */

import { Agent } from "../src/index.js";

async function main() {
  const agent = new Agent({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceDir: process.cwd(),
  });

  const sessionId = "example-basic";

  console.log("Gen Agent Basic Example\n");

  // Subscribe to events (streaming text + tool calls)
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "message_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_execution_start":
        console.log(`\n[Tool call: ${event.toolName}]`);
        break;
    }
  });

  // Example 1: Simple conversation
  console.log("--- Example 1: List files ---");
  const result1 = await agent.run(sessionId, "List the files in the current directory");
  console.log(`\nDone: ${result1.turns} turns, ${result1.toolCalls} tool calls\n`);

  // Example 2: Code operation
  console.log("--- Example 2: Read package.json ---");
  const result2 = await agent.run(sessionId, "Read package.json and tell me the project name");
  console.log(`\nDone: ${result2.turns} turns\n`);

  // Cleanup
  unsubscribe();
  await agent.reset(sessionId);
}

main().catch(console.error);
