import "dotenv/config";

export interface AgentConfig {
  centralUrl: string;
  agentToken: string;
  agentName: string;
  heartbeatIntervalMs: number;
}

export function loadConfig(): AgentConfig {
  const centralUrl = process.env.CENTRAL_URL ?? "ws://localhost:8080";
  const agentToken = process.env.AGENT_TOKEN;

  if (!agentToken) {
    throw new Error("AGENT_TOKEN is required");
  }

  return {
    centralUrl: centralUrl.replace(/\/$/, ""),
    agentToken,
    agentName: process.env.AGENT_NAME ?? process.env.HOSTNAME ?? "unknown-vps",
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15_000)
  };
}
