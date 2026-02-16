/**
 * Tool Policy
 *
 * Three-tier CompiledPattern design:
 * - "all"   → "*" matches everything, short-circuit return
 * - "exact" → no wildcards, direct string comparison, zero RegExp overhead
 * - "regex" → contains * wildcards, compiled into a safe RegExp
 *
 * Escape chain (regex branch only):
 *   1. First escape all regex special characters: "exec*" → "exec\*"
 *   2. Then replace "\*" (escaped wildcard) with ".*": "exec\*" → "exec.*"
 *   3. Add start/end anchors: "^exec.*$"
 *   Effect: user input like . ( ) etc. are treated as literals; only * acts as wildcard
 */

import type { Tool } from "./tools/types.js";

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

// ============== Three-tier compilation modes ==============

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

/**
 * Tool name normalization
 *
 * - apply-patch → apply_patch
 * - bash → exec
 */
function normalizeToolName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  // Alias mapping
  if (trimmed === "apply-patch") return "apply_patch";
  if (trimmed === "bash") return "exec";
  return trimmed;
}

/**
 * Compile pattern into one of three tiers
 */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  // "*" → matches everything
  if (normalized === "*") {
    return { kind: "all" };
  }
  // No wildcard → exact match, no RegExp constructed
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  // Contains wildcard → safely compile to RegExp
  // Step 1: Escape all regex special characters (including *)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Step 2: Replace escaped \* back to .* (wildcard semantics)
  const regex = `^${escaped.replaceAll("\\*", ".*")}$`;
  return { kind: "regex", value: new RegExp(regex) };
}

function compilePatterns(patterns: string[]): CompiledPattern[] {
  return patterns.map(compilePattern);
}

/**
 * Match against a list of compiled patterns
 */
function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && name === pattern.value) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

// ============== Public API ==============

/**
 * Check if a tool is allowed by policy
 *
 * Evaluation order:
 * 1. deny takes priority — if it matches deny, reject
 * 2. allow is empty — allow everything
 * 3. allow matches — explicitly allowed
 * 4. apply_patch inherits exec permissions (special rule)
 * 5. Default: reject
 */
export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;

  const normalized = normalizeToolName(name);
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);

  if (matchesAny(normalized, deny)) return false;
  if (allow.length === 0) return true;
  if (matchesAny(normalized, allow)) return true;
  // apply_patch inherits exec permissions
  if (normalized === "apply_patch" && matchesAny("exec", allow)) return true;
  return false;
}

export function filterToolsByPolicy(tools: Tool[], policy?: ToolPolicy): Tool[] {
  if (!policy) return tools;
  // Pre-compile once to avoid recompiling N times for N tools
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);
  return tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name);
    if (matchesAny(normalized, deny)) return false;
    if (allow.length === 0) return true;
    if (matchesAny(normalized, allow)) return true;
    // apply_patch inherits exec permissions
    if (normalized === "apply_patch" && matchesAny("exec", allow)) return true;
    return false;
  });
}
