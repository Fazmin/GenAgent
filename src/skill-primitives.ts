/**
 * Skill low-level primitives (corresponding to pi-coding-agent SDK layer)
 *
 * This file emulates the basic skill capabilities provided by @mariozechner/pi-coding-agent:
 * - Skill type definition
 * - loadSkillsFromDir() — directory scanning and SKILL.md parsing
 * - formatSkillsForPrompt() — XML prompt generation (Agent Skills standard)
 *
 * The original source does not implement these primitives itself, but references the SDK directly:
 *   import { Skill, loadSkillsFromDir, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent"
 *
 * Gen Agent does not depend on the SDK, so it implements them here. The upper layer skills.ts
 * reuses these primitives via:
 *   import { type Skill, loadSkillsFromDir, formatSkillsForPrompt } from "./skill-primitives.js"
 * which mirrors the original layered structure.
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

// ============== Types ==============

/**
 * Skill definition (corresponding to pi-coding-agent's Skill interface)
 *
 * The SDK only cares about the most basic fields; no orchestration layer concepts
 * (invocation policy, command matching, etc.)
 * - name is the unique identifier (from directory name or frontmatter name)
 * - filePath points to the absolute path of SKILL.md; the model can read it on demand
 */
export interface Skill {
  /** Skill name (unique identifier, from frontmatter or parent directory name) */
  name: string;
  /** Human-readable description (injected into <available_skills> prompt to tell the model when to use it) */
  description: string;
  /** Absolute path to SKILL.md file (model reads via read tool for detailed instructions) */
  filePath: string;
  /** Directory containing the skill (relative paths in SKILL.md are resolved from this directory) */
  baseDir: string;
  /** Source identifier (e.g. "managed", "workspace"), used for tracing priority in multi-layer override */
  source: string;
  /** Whether model autonomous invocation is disabled (true = not injected into prompt, only triggered via /command) */
  disableModelInvocation: boolean;
}

// ============== Directory scanning ==============

/**
 * Load skills from directory
 *
 * Based on: pi-coding-agent loadSkillsFromDir()
 * Discovery rules:
 * - Root directory: any .md file
 * - Subdirectories (recursive): only SKILL.md
 * - Skips dotfiles and node_modules
 */
export async function loadSkillsFromDir(params: {
  dir: string;
  source: string;
}): Promise<Skill[]> {
  const { dir, source } = params;
  const skills: Skill[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const skill = await loadSkillFromFile(
        path.join(fullPath, "SKILL.md"),
        fullPath,
        source,
      );
      if (skill) skills.push(skill);
      // Recursively scan subdirectories
      const sub = await scanSubdirs(fullPath, source);
      skills.push(...sub);
    } else if (entry.name.endsWith(".md")) {
      const skill = await loadSkillFromFile(fullPath, dir, source);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

/** Recursive subdirectory scan (only looks for SKILL.md) */
async function scanSubdirs(dir: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    const skill = await loadSkillFromFile(
      path.join(fullPath, "SKILL.md"),
      fullPath,
      source,
    );
    if (skill) skills.push(skill);
    const sub = await scanSubdirs(fullPath, source);
    skills.push(...sub);
  }
  return skills;
}

/**
 * Load a single skill file
 *
 * Based on: pi-coding-agent internal loadSkillFromFile
 * - Parses YAML frontmatter to extract name, description, disable-model-invocation
 * - name priority: frontmatter > parent directory name > filename (without .md)
 * - description is required; entries without a description are skipped
 */
async function loadSkillFromFile(
  filePath: string,
  baseDir: string,
  source: string,
): Promise<Skill | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const fm = extractFrontmatter(content);
  // name priority: frontmatter declaration > parent directory name > filename (without .md)
  const name =
    fm.name?.trim() ||
    path.basename(baseDir).toLowerCase() ||
    path.basename(filePath, ".md").toLowerCase();
  const description = fm.description?.trim() || "";
  if (!description) return null;

  return {
    name,
    description,
    filePath: path.resolve(filePath),
    baseDir: path.resolve(baseDir),
    source,
    disableModelInvocation: parseBool(fm["disable-model-invocation"], false),
  };
}

/**
 * Simple YAML frontmatter extraction
 *
 * Based on: pi-coding-agent internal frontmatter parser
 * - Only handles single-line key: value format
 * - Strips quote wrapping ("value" → value)
 * - SDK layer only needs to extract name/description/disable-model-invocation
 *   The orchestration layer (skills.ts) re-reads the file with its own parser
 *   to extract additional fields
 */
function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
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

// ============== Prompt formatting ==============

const XML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch] ?? ch);
}

/**
 * Generate XML-formatted skills prompt
 *
 * Based on: pi-coding-agent formatSkillsForPrompt()
 * - Agent Skills standard: https://agentskills.io
 * - Automatically filters out skills with disableModelInvocation === true
 * - Output format is fully consistent with pi-coding-agent
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(s.name)}</name>`);
    lines.push(`    <description>${escapeXml(s.description)}</description>`);
    lines.push(`    <location>${escapeXml(s.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
