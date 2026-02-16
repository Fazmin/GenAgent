/**
 * Skill orchestration layer (based on src/agents/skills/)
 *
 * Built on top of skill-primitives (SDK layer), only handles orchestration and policy
 * that the SDK does not provide:
 * - Multi-layer directory loading and merging (managed < workspace)
 * - Frontmatter metadata extraction (fields beyond the SDK)
 * - Invocation policy parsing (userInvocable / disableModelInvocation)
 * - /command slash command matching
 * - Command name sanitize + deduplication
 * - SkillManager public API
 *
 * Layering:
 *   Original workspace.ts:1-5 →
 *     import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent"
 *   Gen Agent skills.ts below →
 *     import { type Skill, loadSkillsFromDir, formatSkillsForPrompt } from "./skill-primitives.js"
 *
 * i.e. SDK provides primitives, orchestration layer handles policy.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Low-level primitives from skill-primitives (corresponding to pi-coding-agent SDK)
 *
 * Based on: import { ... } from "@mariozechner/pi-coding-agent"
 */
import {
  type Skill,
  loadSkillsFromDir,
  formatSkillsForPrompt,
} from "./skill-primitives.js";

// Re-export SDK types for external use
export type { Skill };

// ============== Type definitions ==============

/**
 * Parsed frontmatter key-value pairs
 *
 * Based on: ParsedSkillFrontmatter
 * All values are coerced to string (aligned with the coercion strategy)
 */
export type ParsedSkillFrontmatter = Record<string, string>;

/**
 * Skill invocation policy
 *
 * Based on: SkillInvocationPolicy
 * Two boolean values independently control two trigger channels:
 * - userInvocable controls the user /command channel
 * - disableModelInvocation controls the model autonomous trigger channel
 */
export type SkillInvocationPolicy = {
  /** Whether the user can invoke via /command */
  userInvocable: boolean;
  /** Whether to disable injection into model prompt */
  disableModelInvocation: boolean;
};

/**
 * Loaded complete skill entry
 *
 * Based on: SkillEntry
 * - skill field comes from the SDK's loadSkillsFromDir (low-level primitive)
 * - frontmatter/invocation are extracted by the orchestration layer re-reading the file
 *   (the SDK does not care about these fields)
 */
export type SkillEntry = {
  /** SDK-returned Skill object (name/description/filePath/baseDir/source) */
  skill: Skill;
  /** Orchestration layer parsed complete frontmatter key-value pairs */
  frontmatter: ParsedSkillFrontmatter;
  /** Invocation policy (controls user /command and model autonomous invocation channels) */
  invocation: SkillInvocationPolicy;
};

/**
 * Skill command spec (slash command registration entry)
 *
 * Based on: SkillCommandSpec
 * Built by buildSkillCommandSpecs() from SkillEntry[],
 * used for /command matching and command list display
 */
export type SkillCommandSpec = {
  /** Command name (sanitized, used for /name trigger) */
  name: string;
  /** Original skill.name */
  skillName: string;
  /** Description (truncated to 100 characters) */
  description: string;
};

/**
 * Slash command match result
 *
 * Based on: resolveSkillCommandInvocation return value
 */
export interface SkillMatch {
  /** Matched command spec */
  command: SkillCommandSpec;
  /** Arguments part after the command (e.g. "-m fix" in "/commit -m fix") */
  args?: string;
}

// ============== Frontmatter parsing ==============

/**
 * Parse frontmatter into key-value pairs
 *
 * Based on: parseFrontmatter() → parseFrontmatterBlock()
 * The orchestration layer has its own frontmatter parser outside the SDK,
 * used to extract metadata fields the SDK does not care about (invocation policy, etc.)
 */
function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: ParsedSkillFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return fallback;
}

/** Based on: resolveSkillInvocationPolicy() */
function resolveInvocationPolicy(fm: ParsedSkillFrontmatter): SkillInvocationPolicy {
  return {
    userInvocable: parseBool(fm["user-invocable"], true),
    disableModelInvocation: parseBool(fm["disable-model-invocation"], false),
  };
}

// ============== Skill loading and merging ==============

/**
 * Load skill entries (multi-layer merge + metadata enrichment)
 *
 * Based on: loadSkillEntries()
 * Flow:
 * 1. Call SDK's loadSkillsFromDir to scan multiple directories → Skill[]
 * 2. Name-based Map merge (later loads override earlier ones)
 * 3. Re-read files to extract orchestration layer frontmatter metadata → SkillEntry[]
 *
 * The "re-read file" step corresponds to the original approach:
 * The SDK has already read once to extract name/description, but the orchestration
 * layer needs fields the SDK doesn't care about (user-invocable, etc.), so it reads again.
 */
async function loadSkillEntries(
  workspaceDir: string,
  managedDir: string,
): Promise<SkillEntry[]> {
  const merged = new Map<string, Skill>();

  // Priority: managed < workspace (based on: extra < bundled < managed < workspace)
  const managedSkills = await loadSkillsFromDir({ dir: managedDir, source: "managed" });
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }

  const workspaceSkillsDir = path.join(workspaceDir, "skills");
  const workspaceSkills = await loadSkillsFromDir({
    dir: workspaceSkillsDir,
    source: "workspace",
  });
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  // Enrich to SkillEntry (re-read files to extract orchestration layer metadata)
  const entries: SkillEntry[] = [];
  for (const skill of merged.values()) {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = await fs.readFile(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore
    }
    entries.push({
      skill,
      frontmatter,
      invocation: resolveInvocationPolicy(frontmatter),
    });
  }
  return entries;
}

// ============== Command name sanitize ==============

const COMMAND_MAX_LENGTH = 32;
const COMMAND_FALLBACK = "skill";
const DESCRIPTION_MAX_LENGTH = 100; // Discord limit

/** Based on: sanitizeSkillCommandName() */
function sanitizeCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, COMMAND_MAX_LENGTH) || COMMAND_FALLBACK;
}

/** Based on: resolveUniqueSkillCommandName() */
function resolveUniqueCommandName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const maxBase = Math.max(1, COMMAND_MAX_LENGTH - suffix.length);
    const candidate = `${base.slice(0, maxBase)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, Math.max(1, COMMAND_MAX_LENGTH - 2))}_x`;
}

/**
 * Build slash command list
 *
 * Based on: buildWorkspaceSkillCommandSpecs()
 */
function buildSkillCommandSpecs(entries: SkillEntry[]): SkillCommandSpec[] {
  const userInvocable = entries.filter((e) => e.invocation.userInvocable !== false);
  const used = new Set<string>();
  const specs: SkillCommandSpec[] = [];

  for (const entry of userInvocable) {
    const base = sanitizeCommandName(entry.skill.name);
    const unique = resolveUniqueCommandName(base, used);
    used.add(unique.toLowerCase());

    const rawDesc = entry.skill.description?.trim() || entry.skill.name;
    const description =
      rawDesc.length > DESCRIPTION_MAX_LENGTH
        ? `${rawDesc.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
        : rawDesc;

    specs.push({ name: unique, skillName: entry.skill.name, description });
  }
  return specs;
}

// ============== Command matching ==============

/**
 * Normalize command name for fuzzy lookup
 *
 * Based on: normalizeSkillCommandLookup()
 */
function normalizeForLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Fuzzy lookup command (single pass, 4 strategies)
 *
 * Based on: findSkillCommand()
 * Only used for the /skill skillname args path (allows flexible matching)
 */
function findSkillCommand(
  commands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const normalized = normalizeForLookup(trimmed);

  // Single pass; first match on any strategy returns immediately
  return commands.find((entry) => {
    if (entry.name.toLowerCase() === lowered) return true;
    if (entry.skillName.toLowerCase() === lowered) return true;
    return (
      normalizeForLookup(entry.name) === normalized ||
      normalizeForLookup(entry.skillName) === normalized
    );
  });
}

/**
 * Parse slash command
 *
 * Based on: resolveSkillCommandInvocation()
 *
 * The two syntaxes use different matching strategies:
 * - /skill skillname args → findSkillCommand (flexible match: name + skillName + normalized)
 * - /skillname args → strict match on command.name only
 */
function resolveCommandInvocation(
  input: string,
  commands: SkillCommandSpec[],
): SkillMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;

  // /skill skillname args — flexible matching
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;
    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;
    const cmd = findSkillCommand(commands, skillMatch[1] ?? "");
    if (!cmd) return null;
    return { command: cmd, args: skillMatch[2]?.trim() || undefined };
  }

  // /skillname args — strict match on name (entry.name.toLowerCase() === commandName)
  const cmd = commands.find((entry) => entry.name.toLowerCase() === commandName);
  if (!cmd) return null;
  return { command: cmd, args: match[2]?.trim() || undefined };
}

// ============== SkillManager (public API) ==============

export class SkillManager {
  private workspaceDir: string;
  private managedDir: string;
  /** All loaded entries (deduplicated by name, later loads override) */
  private entries: SkillEntry[] = [];
  /** Built slash command list */
  private commands: SkillCommandSpec[] = [];
  private loaded = false;

  /**
   * @param workspaceDir Workspace directory (highest priority skill source)
   * @param managedDir User global directory (~/.gen-agent/skills/)
   */
  constructor(workspaceDir: string, managedDir?: string) {
    this.workspaceDir = workspaceDir;
    this.managedDir =
      managedDir ??
      path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        ".gen-agent",
        "skills",
      );
  }

  /**
   * Load all skills (multi-layer merge + command list build)
   *
   * Based on: loadSkillEntries() + buildWorkspaceSkillCommandSpecs()
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.entries = await loadSkillEntries(this.workspaceDir, this.managedDir);
    this.commands = buildSkillCommandSpecs(this.entries);
    this.loaded = true;
  }

  /**
   * Match slash command
   *
   * Based on: resolveSkillCommandInvocation()
   */
  async match(input: string): Promise<SkillMatch | null> {
    await this.loadAll();
    return resolveCommandInvocation(input, this.commands);
  }

  /** Get skill by name */
  async get(name: string): Promise<Skill | null> {
    await this.loadAll();
    return this.entries.find((e) => e.skill.name === name)?.skill ?? null;
  }

  /** List all skills */
  async list(): Promise<Skill[]> {
    await this.loadAll();
    return this.entries.map((e) => e.skill);
  }

  /** List slash commands */
  async listCommands(): Promise<SkillCommandSpec[]> {
    await this.loadAll();
    return this.commands;
  }

  /**
   * Build skills prompt for system prompt (XML format)
   *
   * Based on: buildWorkspaceSkillsPrompt() → formatSkillsForPrompt()
   * - Only includes skills with disableModelInvocation=false
   * - Calls SDK's formatSkillsForPrompt to generate XML
   */
  async buildSkillsPrompt(): Promise<string> {
    await this.loadAll();
    const skills = this.entries
      .filter((e) => !e.invocation.disableModelInvocation)
      .map((e) => e.skill);
    return formatSkillsForPrompt(skills);
  }
}
