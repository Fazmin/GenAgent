/**
 * Built-in Tool Set
 *
 * This implements 10 core tools covering the Agent's essential capabilities:
 * - read: Read files (perceive code)
 * - write: Write files (create code)
 * - edit: Edit files (modify code)
 * - exec: Execute commands (run tests, install dependencies, etc.)
 * - list: List directories (explore project structure)
 * - grep: Search files (locate code)
 * - memory_search: Memory retrieval (history recall)
 * - memory_get: Memory read (on-demand fetch)
 * - memory_save: Memory write (long-term storage)
 * - sessions_spawn: Sub-agent trigger
 *
 * Design principles:
 * 1. Safety first: All paths are relative to workspaceDir, preventing out-of-bounds access
 * 2. Rate-limited: Output size and timeout have caps to prevent the Agent from hanging or consuming excessive resources
 * 3. Returns strings: All tools return strings for easy LLM comprehension
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "./types.js";
import { assertSandboxPath } from "../sandbox-paths.js";

// ============== File Read ==============

/**
 * Read File Tool
 *
 * Why limit to 500 lines?
 * - LLM context windows are limited (~200K tokens for Claude)
 * - Returning too much content at once consumes valuable context space
 * - 500 lines is usually enough to understand a file's structure
 * - If more is needed, the LLM can call multiple times with an offset
 *
 * Why add line numbers?
 * - Makes it easy for the LLM to reference specific locations ("please modify line 42")
 * - Helps the edit tool locate content precisely
 */
export const readTool: Tool<{ file_path: string; limit?: number }> = {
  name: "read",
  description: "Read file contents, returns text with line numbers",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path" },
      limit: { type: "number", description: "Maximum lines to read, default 500" },
    },
    required: ["file_path"],
  },
  async execute(input, ctx) {
    // Safety: ensure path is within workspaceDir and reject symlink escapes
    let filePath: string;
    try {
      const resolved = await assertSandboxPath({
        filePath: input.file_path,
        cwd: ctx.workspaceDir,
        root: ctx.workspaceDir,
      });
      filePath = resolved.resolved;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    const limit = input.limit ?? 500;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n").slice(0, limit);
      // Format: "lineNumber\tcontent", easy for the LLM to parse
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

// ============== File Write ==============

/**
 * Write File Tool
 *
 * Why overwrite instead of append?
 * - Code files usually need full replacement
 * - Append operations can be done using the edit tool
 * - Overwrite better matches the semantics of "writing a new file"
 *
 * Safety considerations:
 * - Automatically creates parent directories (recursive: true)
 * - Path is relative to workspaceDir; cannot write files outside the workspace
 */
export const writeTool: Tool<{ file_path: string; content: string }> = {
  name: "write",
  description: "Write file, overwrites existing file",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" },
    },
    required: ["file_path", "content"],
  },
  async execute(input, ctx) {
    let filePath: string;
    try {
      const resolved = await assertSandboxPath({
        filePath: input.file_path,
        cwd: ctx.workspaceDir,
        root: ctx.workspaceDir,
      });
      filePath = resolved.resolved;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }

    try {
      // Automatically create parent directories
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, "utf-8");
      return `Successfully wrote ${input.file_path}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

// ============== File Edit ==============

/**
 * Edit File Tool
 *
 * Why use string replacement instead of regex?
 * - String replacement is more predictable with no regex escaping issues
 * - LLM-generated regex may have syntax errors
 * - For code editing, exact matching is safer than fuzzy matching
 *
 * Why use replace() instead of replaceAll()?
 * - Only replacing the first match is more controllable
 * - If all occurrences need replacing, the LLM can call multiple times
 *
 * Typical usage:
 * - LLM first reads the file and sees an issue on line 42
 * - Then uses edit to replace that line's content
 */
export const editTool: Tool<{
  file_path: string;
  old_string: string;
  new_string: string;
}> = {
  name: "edit",
  description: "Edit file, replace specified text (only replaces first match)",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Original text to replace (exact match)" },
      new_string: { type: "string", description: "New text" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    let filePath: string;
    try {
      const resolved = await assertSandboxPath({
        filePath: input.file_path,
        cwd: ctx.workspaceDir,
        root: ctx.workspaceDir,
      });
      filePath = resolved.resolved;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");

      // Check if the text to replace exists
      if (!content.includes(input.old_string)) {
        return "Error: Text to replace not found (ensure old_string exactly matches the file content, including spaces and newlines)";
      }

      // Only replace the first match
      const newContent = content.replace(input.old_string, input.new_string);
      await fs.writeFile(filePath, newContent, "utf-8");
      return `Successfully edited ${input.file_path}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

// ============== Command Execution ==============

/**
 * Execute Command Tool
 *
 * Why default to 30-second timeout?
 * - Most commands (npm install, tsc, pytest) finish within 30 seconds
 * - Timeout prevents the Agent from waiting indefinitely on a stuck command
 * - If more time is needed, the LLM can specify the timeout parameter
 *
 * Why limit output to 30KB (30000 chars)?
 * - Command output can be very large (e.g., npm install logs)
 * - Oversized output consumes LLM context, affecting subsequent reasoning
 * - 30KB is enough to include error messages and key logs
 *
 * Why is maxBuffer 1MB?
 * - Node.js exec default maxBuffer is 1MB
 * - We return only the first 30KB to the LLM, but allow commands to produce more output
 * - This avoids execution failures due to excessive output
 *
 * Safety considerations:
 * - cwd is set to workspaceDir; commands execute within the workspace
 * - This doesn't fully prevent malicious commands; production should use a Docker sandbox
 */
/**
 * Execute Command Tool
 *
 * AbortSignal integration:
 * - When abort signal fires, the foreground process is killed
 * - Timeout still applies (timeout and abort are independent)
 */
export const execTool: Tool<{ command: string; timeout?: number }> = {
  name: "exec",
  description: "Execute shell command",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to execute" },
      timeout: { type: "number", description: "Timeout (ms), default 30000" },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const timeout = input.timeout ?? 30000;

    try {
      const child = spawn("sh", ["-c", input.command], {
        cwd: ctx.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // AbortSignal → kill process
      const onAbort = () => {
        try { child.kill(); } catch { /* ignore */ }
      };
      if (ctx.abortSignal?.aborted) {
        onAbort();
      } else if (ctx.abortSignal) {
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // Timeout timer
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
      }, timeout);

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
        child.on("error", () => resolve(null));
      });

      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener("abort", onAbort);

      let result = stdout;
      if (stderr) result += `\n[STDERR]\n${stderr}`;
      if (exitCode !== null && exitCode !== 0) {
        result += `\n[EXIT CODE] ${exitCode}`;
      }

      return result.slice(0, 30000);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

// ============== Directory Listing ==============

/**
 * List Directory Tool
 *
 * Based on: ls tool pattern
 * - Only accepts path and limit, no pattern
 * - Glob filtering is the responsibility of a find tool; ls keeps a single responsibility
 * - Sorted alphabetically, directories marked with / suffix
 * - Entry count is limited to prevent large directories (e.g. node_modules) from blowing up context
 */
export const listTool: Tool<{ path?: string; limit?: number }> = {
  name: "list",
  description: "List directory contents (sorted alphabetically, directories end with /)",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, defaults to current directory" },
      limit: { type: "number", description: "Maximum entries, default 500" },
    },
  },
  async execute(input, ctx) {
    let dirPath: string;
    try {
      const resolved = await assertSandboxPath({
        filePath: input.path ?? ".",
        cwd: ctx.workspaceDir,
        root: ctx.workspaceDir,
      });
      dirPath = resolved.resolved;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }

    const limit = input.limit ?? 500;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Sort alphabetically (case-insensitive)
      const sorted = entries
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      const lines = sorted
        .slice(0, limit)
        .map((e) => e.isDirectory() ? `${e.name}/` : e.name);

      if (sorted.length > limit) {
        lines.push(`\n[Truncated, ${sorted.length} total items, showing first ${limit}]`);
      }

      return lines.join("\n") || "Directory is empty";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

// ============== File Search ==============

/**
 * Search File Content Tool
 *
 * Why use grep instead of a custom implementation?
 * - grep has been optimized over decades, with excellent performance
 * - Supports regular expressions
 * - Automatically outputs filenames and line numbers
 *
 * Why limit file types?
 * - Only searches .ts .js .json .md and other text files
 * - Avoids searching binary files, images, etc.
 * - Avoids searching large numbers of files in node_modules (grep -r recurses)
 *
 * Why head -50?
 * - Search results can be in the thousands
 * - 50 results are enough for the LLM to locate issues
 * - If more are needed, the search scope can be narrowed
 *
 * Why 10-second timeout?
 * - Searching large projects can be slow
 * - 10 seconds is enough for most projects
 * - Timeout is better than hanging
 */
export const grepTool: Tool<{ pattern: string; path?: string }> = {
  name: "grep",
  description: "Search text in files (supports regular expressions)",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search" },
      path: { type: "string", description: "Search path, defaults to current directory" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    try {
      const resolved = await assertSandboxPath({
        filePath: input.path ?? ".",
        cwd: ctx.workspaceDir,
        root: ctx.workspaceDir,
      });
      const searchPath = resolved.resolved;

      const output = await runRipgrep({
        cwd: ctx.workspaceDir,
        pattern: input.pattern,
        searchPath,
        timeoutMs: 10000,
        limit: 100,
      });

      return output || "No matches found";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

async function runRipgrep(params: {
  cwd: string;
  pattern: string;
  searchPath: string;
  timeoutMs: number;
  limit: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--line-number",
      "--color=never",
      "--hidden",
      "--no-messages",
    ];
    args.push(params.pattern, params.searchPath);

    const child = spawn("rg", args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      settle(() => reject(new Error("rg timeout")));
    }, params.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      settle(() => reject(error));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0 && code !== 1) {
        const message = stderr.trim() || `rg exited with code ${code}`;
        settle(() => reject(new Error(message)));
        return;
      }
      const lines = stdout.split("\n").filter((line) => line.trim());
      const limited = lines.slice(0, Math.max(1, params.limit));
      let output = limited.join("\n");
      if (lines.length > params.limit) {
        output += `\n\n[Truncated, showing first ${params.limit} matches]`;
      }
      if (output.length > 30000) {
        output = `${output.slice(0, 30000)}\n\n[Output too long, truncated]`;
      }
      settle(() => resolve(output));
    });
  });
}

// ============== Memory Tools ==============

/**
 * Memory Search Tool
 *
 * Design goal:
 * - Let the LLM proactively call memory search, rather than auto-injecting
 * - Control context size: search first, then fetch on demand
 */
export const memorySearchTool: Tool<{ query: string; limit?: number }> = {
  name: "memory_search",
  description: "Search long-term memory index, returns a list of relevant memory summaries",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword or query" },
      limit: { type: "number", description: "Number of results, default 5" },
    },
    required: ["query"],
  },
  async execute(input, ctx) {
    const memory = ctx.memory;
    if (!memory) {
      return "Memory system not enabled";
    }
    const results = await memory.search(input.query, input.limit ?? 5);
    ctx.onMemorySearch?.(results);
    if (results.length === 0) {
      return "No relevant memories found";
    }
    const lines = results.map(
      (r, i) =>
        `${i + 1}. [${r.entry.id}] score=${r.score.toFixed(2)} source=${r.entry.source}\n   ${r.snippet}`,
    );
    return lines.join("\n");
  },
};

/**
 * Memory Get Tool
 *
 * Used to fetch the full content of a specific memory after memory_search.
 */
export const memoryGetTool: Tool<{ id: string }> = {
  name: "memory_get",
  description: "Read the full content of a memory by ID",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Memory ID (from memory_search)" },
    },
    required: ["id"],
  },
  async execute(input, ctx) {
    const memory = ctx.memory;
    if (!memory) {
      return "Memory system not enabled";
    }
    const entry = await memory.getById(input.id);
    if (!entry) {
      return `Memory not found: ${input.id}`;
    }
    return `[${entry.id}] ${entry.content}`;
  },
};

// ============== Memory Save Tool ==============

/**
 * Memory Save Tool
 *
 * Design notes:
 * - Gen Agent's memory system uses a JSON index (not filesystem), so a dedicated tool is used
 * - Core idea: the LLM autonomously decides what's worth remembering, rather than the system auto-saving every conversation turn
 */
export const memorySaveTool: Tool<{
  content: string;
}> = {
  name: "memory_save",
  description: "Save important information to long-term memory (use only when info is worth persisting: user preferences, key decisions, important TODOs, etc.)",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Content to save" },
    },
    required: ["content"],
  },
  async execute(input, ctx) {
    const memory = ctx.memory;
    if (!memory) {
      return "Memory system not enabled";
    }
    const id = await memory.add(input.content, "memory");
    return `Saved to long-term memory: ${id}`;
  },
};

// ============== Sub-agent Tool ==============

/**
 * Sub-agent Trigger Tool (minimal version)
 *
 * Design goal:
 * - Allow the main agent to delegate tasks to background sub-agents
 * - Sub-agents return summaries upon completion (event stream)
 */
export const sessionsSpawnTool: Tool<{
  task: string;
  label?: string;
  cleanup?: "keep" | "delete";
}> = {
  name: "sessions_spawn",
  description: "Launch sub-agent for background task, returns summary upon completion",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Sub-agent task description" },
      label: { type: "string", description: "Optional label" },
      cleanup: { type: "string", description: "Whether to clean up session after completion: keep|delete" },
    },
    required: ["task"],
  },
  async execute(input, ctx) {
    if (!ctx.spawnSubagent) {
      return "Sub-agent system not enabled";
    }
    const result = await ctx.spawnSubagent({
      task: input.task,
      label: input.label,
      cleanup: input.cleanup,
    });
    return `Sub-agent started: runId=${result.runId} sessionKey=${result.sessionKey}`;
  },
};

// ============== Export ==============

/**
 * All built-in tools
 *
 * These 10 tools cover the Agent's core capabilities:
 * - Perception: read, list, grep
 * - Action: write, edit, exec
 * - Memory: memory_search, memory_get, memory_save
 * - Orchestration: sessions_spawn
 */
export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  execTool,
  listTool,
  grepTool,
  memorySearchTool,
  memoryGetTool,
  memorySaveTool,
  sessionsSpawnTool,
];
