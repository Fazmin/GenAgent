/**
 * Session Key specification (simplified)
 *
 * The sessionKey is the core of routing and isolation.
 * This retains the essential structure: agent:<agentId>:<mainKey>
 *
 * Design goals:
 * 1. Unified session naming to avoid state confusion between different agents
 * 2. Support explicit sessionKey as well as sessionId auto-completion
 * 3. Provide the minimal form of a "system-level" session scope
 */

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== "agent") {
    return null;
  }
  const agentId = normalizeAgentId(parts[1]);
  const rest = parts.slice(2).join(":").trim();
  if (!rest) {
    return null;
  }
  return { agentId, rest };
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return false;
  }
  return parsed.rest.trim().toLowerCase().startsWith("subagent:");
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

export function toAgentStoreSessionKey(params: {
  agentId: string;
  requestKey: string | undefined | null;
  mainKey?: string | undefined;
}): string {
  const raw = (params.requestKey ?? "").trim();
  if (!raw || normalizeToken(raw) === DEFAULT_MAIN_KEY) {
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey: params.mainKey });
  }
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}

/**
 * Unified entry point: normalize sessionId / sessionKey into a sessionKey
 */
export function resolveSessionKey(params: {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const explicit = params.sessionKey?.trim();
  if (explicit) {
    return toAgentStoreSessionKey({ agentId, requestKey: explicit });
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return toAgentStoreSessionKey({ agentId, requestKey: sessionId });
  }
  return buildAgentMainSessionKey({ agentId, mainKey: DEFAULT_MAIN_KEY });
}
