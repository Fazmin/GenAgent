import {
  buildBootstrapContextFiles,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_SOUL_FILENAME,
  type BootstrapFile,
  type ContextFile,
} from "./bootstrap.js";

export class ContextLoader {
  private workspaceDir: string;
  private maxChars?: number;
  private warn?: (message: string) => void;

  constructor(
    workspaceDir: string,
    opts?: {
      maxChars?: number;
      warn?: (message: string) => void;
    },
  ) {
    this.workspaceDir = workspaceDir;
    this.maxChars = opts?.maxChars;
    this.warn = opts?.warn;
  }

  /**
   * Load and filter Bootstrap files
   */
  async loadBootstrapFiles(params?: {
    sessionKey?: string;
  }): Promise<BootstrapFile[]> {
    const files = await loadWorkspaceBootstrapFiles(this.workspaceDir);
    return filterBootstrapFilesForSession(files, params?.sessionKey);
  }

  /**
   * Build the context portion of the system prompt (Project Context)
   */
  async buildContextPrompt(params?: { sessionKey?: string }): Promise<string> {
    const files = await this.loadBootstrapFiles(params);
    const contextFiles = buildBootstrapContextFiles(files, {
      maxChars: this.maxChars,
      warn: this.warn,
    });
    if (contextFiles.length === 0) return "";

    const hasSoulFile = contextFiles.some((file) => {
      const normalized = file.path.trim().replace(/\\/g, "/");
      const baseName = normalized.split("/").pop() ?? normalized;
      return baseName.toLowerCase() === DEFAULT_SOUL_FILENAME.toLowerCase();
    });

    const lines: string[] = [
      "",
      "## Workspace files (injected)",
      "The following files are editable context, injected into Project Context:",
      "",
      "# Project Context",
      "",
      "Project context files loaded:",
    ];
    if (hasSoulFile) {
      lines.push(
        "If SOUL.md exists, follow its personality and tone guidelines, and avoid mechanical responses (unless overridden by higher-priority instructions).",
      );
    }
    lines.push("");

    for (const file of contextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }

    return lines.join("\n");
  }

  /**
   * Check if HEARTBEAT.md has pending tasks
   */
  async hasHeartbeatTasks(): Promise<boolean> {
    const files = await loadWorkspaceBootstrapFiles(this.workspaceDir);
    const heartbeat = files.find((f) => f.name === DEFAULT_HEARTBEAT_FILENAME);
    if (!heartbeat?.content) return false;

    // Check if there is non-empty content (excluding titles and empty lines)
    const lines = heartbeat.content.split("\n");
    return lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !/^#+(\s|$)/.test(trimmed) &&
        !/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)
      );
    });
  }
}

export type { ContextFile };
