import { getAllSettings } from "./db";
import { createRequire } from "module";

// Use createRequire + computed string to bypass Turbopack's static analysis
// gen-agent is only used on the server side (API routes) and is listed
// in serverExternalPackages in next.config.ts
const _require = createRequire(import.meta.url);
const GEN_AGENT_PKG = ["gen", "agent"].join("-");

function loadGenAgent() {
  return _require(GEN_AGENT_PKG);
}

export interface SimpleAgentConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  workspaceDir?: string;
  enableMemory?: boolean;
  enableContext?: boolean;
  enableSkills?: boolean;
  enableHeartbeat?: boolean;
  maxTurns?: number;
}

let agentInstance: any = null;
let currentConfigHash: string = "";

function getConfigHash(config: SimpleAgentConfig): string {
  return JSON.stringify({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
  });
}

export function getAgentConfig(): SimpleAgentConfig {
  const settings = getAllSettings();
  return {
    provider: settings["provider"] || "anthropic",
    model: settings["model"] || undefined,
    apiKey: settings["apiKey"] || undefined,
    workspaceDir: process.cwd(),
    enableMemory: settings["enableMemory"] !== "false",
    enableContext: settings["enableContext"] !== "false",
    enableSkills: settings["enableSkills"] !== "false",
    enableHeartbeat: false,
    maxTurns: parseInt(settings["maxTurns"] || "20", 10),
  };
}

export function getOrCreateAgent(): any {
  const config = getAgentConfig();
  const hash = getConfigHash(config);

  if (agentInstance && currentConfigHash === hash) {
    return agentInstance;
  }

  const genAgent = loadGenAgent();
  agentInstance = new genAgent.Agent(config);
  currentConfigHash = hash;
  return agentInstance;
}

export function resetAgent(): void {
  agentInstance = null;
  currentConfigHash = "";
}
