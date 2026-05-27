import { IncomingMessage } from "node:http";
import { PrismaClient, CommandAction, CommandStatus, ServiceStatus } from "@prisma/client";
import WebSocket from "ws";
import { RealtimeHub } from "./realtime";
import { hashToken, maskSecrets } from "./security";

interface AgentConnection {
  serverId: string;
  socket: WebSocket;
}

interface AgentHeartbeat {
  identity: {
    hostname: string;
    os: string;
    architecture: string;
    ipAddress?: string;
  };
  metrics: {
    cpuPercent: number;
    load1?: number;
    load5?: number;
    load15?: number;
    memoryTotal: number;
    memoryUsed: number;
    diskTotal?: number;
    diskUsed?: number;
    diskPercent?: number;
    networkRxBytes?: number;
    networkTxBytes?: number;
    uptimeSeconds?: number;
  };
  services: Array<{
    pm2Name: string;
    name: string;
    pid?: number;
    status: string;
    cpuPercent?: number;
    memoryBytes?: number;
    restartCount?: number;
    uptimeMs?: number;
    sourcePath?: string;
  }>;
}

interface AgentCommandOutput {
  commandId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

interface AgentCommandFinished {
  commandId: string;
  status: CommandStatus;
  exitCode?: number;
  errorMessage?: string;
}

export interface DispatchableCommand {
  commandId: string;
  action: CommandAction;
  service?: {
    id: string;
    pm2Name: string;
    sourcePath?: string | null;
  };
  timeoutMs?: number;
}

export interface DispatchableLogStream {
  streamId: string;
  service: {
    pm2Name: string;
  };
  lines?: number;
}

export class AgentGateway {
  private readonly connections = new Map<string, AgentConnection>();

  constructor(private readonly prisma: PrismaClient, private readonly realtime: RealtimeHub) {}

  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(1008, "Missing token");
      return;
    }

    const server = await this.prisma.server.findUnique({
      where: {
        agentTokenHash: hashToken(token)
      }
    });

    if (!server) {
      socket.close(1008, "Invalid token");
      return;
    }

    this.connections.set(server.id, {
      serverId: server.id,
      socket
    });

    await this.prisma.server.update({
      where: { id: server.id },
      data: {
        status: "ONLINE",
        lastSeenAt: new Date()
      }
    });

    this.realtime.broadcast({ type: "server.online", payload: { serverId: server.id } });

    socket.on("message", (raw) => {
      void this.handleMessage(server.id, raw.toString());
    });
    socket.on("close", () => {
      void this.markOffline(server.id);
    });
  }

  isOnline(serverId: string): boolean {
    return this.connections.get(serverId)?.socket.readyState === WebSocket.OPEN;
  }

  removeServer(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    this.connections.delete(serverId);
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.close(1000, "Server removed");
    }
  }

  sendCommand(serverId: string, command: DispatchableCommand): boolean {
    const connection = this.connections.get(serverId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    connection.socket.send(
      JSON.stringify({
        type: "command",
        payload: command
      })
    );
    return true;
  }

  startLogStream(serverId: string, request: DispatchableLogStream): boolean {
    const connection = this.connections.get(serverId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    connection.socket.send(
      JSON.stringify({
        type: "startLog",
        payload: request
      })
    );
    return true;
  }

  stopLogStream(serverId: string, streamId: string): boolean {
    const connection = this.connections.get(serverId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    connection.socket.send(
      JSON.stringify({
        type: "stopLog",
        payload: { streamId }
      })
    );
    return true;
  }

  private async handleMessage(serverId: string, raw: string): Promise<void> {
    let message: { type?: string; payload?: unknown };
    try {
      message = JSON.parse(raw) as { type?: string; payload?: unknown };
    } catch {
      return;
    }

    if (message.type === "heartbeat") {
      await this.handleHeartbeat(serverId, message.payload as AgentHeartbeat);
      return;
    }

    if (message.type === "commandStarted") {
      const payload = message.payload as { commandId: string };
      await this.prisma.command.update({
        where: { id: payload.commandId },
        data: { status: "RUNNING", startedAt: new Date() }
      });
      this.realtime.broadcast({ type: "command.started", payload });
      return;
    }

    if (message.type === "commandOutput") {
      await this.handleCommandOutput(message.payload as AgentCommandOutput);
      return;
    }

    if (message.type === "commandFinished") {
      await this.handleCommandFinished(message.payload as AgentCommandFinished);
      return;
    }

    if (message.type === "logOutput") {
      const payload = message.payload as { streamId: string; pm2Name: string; chunk: string };
      this.realtime.broadcast({
        type: "log.output",
        payload: {
          ...payload,
          serverId,
          chunk: maskSecrets(payload.chunk)
        }
      });
      return;
    }

    if (message.type === "logEnded") {
      this.realtime.broadcast({
        type: "log.ended",
        payload: {
          ...(message.payload as { streamId: string }),
          serverId
        }
      });
    }
  }

  private async handleHeartbeat(serverId: string, heartbeat: AgentHeartbeat): Promise<void> {
    const now = new Date();
    const statusByPm2Status: Record<string, ServiceStatus> = {
      online: "RUNNING",
      stopped: "STOPPED",
      errored: "ERRORED",
      stopping: "STOPPED",
      launching: "UNKNOWN"
    };

    await this.prisma.$transaction([
      this.prisma.server.update({
        where: { id: serverId },
        data: {
          hostname: heartbeat.identity.hostname,
          ipAddress: heartbeat.identity.ipAddress,
          os: heartbeat.identity.os,
          architecture: heartbeat.identity.architecture,
          status: "ONLINE",
          lastSeenAt: now
        }
      }),
      this.prisma.metric.create({
        data: {
          serverId,
          cpuPercent: heartbeat.metrics.cpuPercent,
          load1: heartbeat.metrics.load1,
          load5: heartbeat.metrics.load5,
          load15: heartbeat.metrics.load15,
          memoryTotal: BigInt(heartbeat.metrics.memoryTotal),
          memoryUsed: BigInt(heartbeat.metrics.memoryUsed),
          diskTotal: heartbeat.metrics.diskTotal ? BigInt(heartbeat.metrics.diskTotal) : undefined,
          diskUsed: heartbeat.metrics.diskUsed ? BigInt(heartbeat.metrics.diskUsed) : undefined,
          diskPercent: heartbeat.metrics.diskPercent,
          networkRxBytes: heartbeat.metrics.networkRxBytes ? BigInt(heartbeat.metrics.networkRxBytes) : undefined,
          networkTxBytes: heartbeat.metrics.networkTxBytes ? BigInt(heartbeat.metrics.networkTxBytes) : undefined,
          uptimeSeconds: heartbeat.metrics.uptimeSeconds ? BigInt(Math.round(heartbeat.metrics.uptimeSeconds)) : undefined
        }
      }),
      ...heartbeat.services.map((service) =>
        this.prisma.service.upsert({
          where: {
            serverId_pm2Name: {
              serverId,
              pm2Name: service.pm2Name
            }
          },
          create: {
            serverId,
            name: service.name,
            pm2Name: service.pm2Name,
            sourcePath: service.sourcePath,
            status: statusByPm2Status[service.status] ?? "UNKNOWN",
            pid: service.pid,
            cpuPercent: service.cpuPercent,
            memoryBytes: service.memoryBytes ? BigInt(service.memoryBytes) : undefined,
            restartCount: service.restartCount,
            uptimeMs: service.uptimeMs ? BigInt(service.uptimeMs) : undefined,
            lastSeenAt: now
          },
          update: {
            name: service.name,
            sourcePath: service.sourcePath,
            status: statusByPm2Status[service.status] ?? "UNKNOWN",
            pid: service.pid,
            cpuPercent: service.cpuPercent,
            memoryBytes: service.memoryBytes ? BigInt(service.memoryBytes) : undefined,
            restartCount: service.restartCount,
            uptimeMs: service.uptimeMs ? BigInt(service.uptimeMs) : undefined,
            lastSeenAt: now
          }
        })
      )
    ]);

    this.realtime.broadcast({
      type: "server.heartbeat",
      payload: {
        serverId,
        metrics: heartbeat.metrics,
        services: heartbeat.services
      }
    });

    if (heartbeat.metrics.diskPercent && heartbeat.metrics.diskPercent >= 90) {
      this.realtime.broadcast({
        type: "alert.disk",
        payload: {
          serverId,
          diskPercent: heartbeat.metrics.diskPercent
        }
      });
    }

    for (const service of heartbeat.services) {
      if (statusByPm2Status[service.status] === "ERRORED") {
        this.realtime.broadcast({
          type: "alert.service",
          payload: {
            serverId,
            pm2Name: service.pm2Name,
            status: service.status
          }
        });
      }
    }
  }

  private async handleCommandOutput(payload: AgentCommandOutput): Promise<void> {
    const chunk = maskSecrets(payload.chunk);
    const command = await this.prisma.command.findUnique({
      where: { id: payload.commandId },
      select: { stdout: true, stderr: true }
    });

    if (!command) {
      return;
    }

    await this.prisma.command.update({
      where: { id: payload.commandId },
      data:
        payload.stream === "stdout"
          ? { stdout: command.stdout + chunk }
          : { stderr: command.stderr + chunk }
    });

    this.realtime.broadcast({
      type: "command.output",
      payload: {
        ...payload,
        chunk
      }
    });
  }

  private async handleCommandFinished(payload: AgentCommandFinished): Promise<void> {
    await this.prisma.command.update({
      where: { id: payload.commandId },
      data: {
        status: payload.status,
        exitCode: payload.exitCode,
        errorMessage: payload.errorMessage ? maskSecrets(payload.errorMessage) : undefined,
        finishedAt: new Date()
      }
    });

    await this.prisma.deployment.updateMany({
      where: { commandId: payload.commandId },
      data: {
        status: payload.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        finishedAt: new Date()
      }
    });

    this.realtime.broadcast({ type: "command.finished", payload });
  }

  private async markOffline(serverId: string): Promise<void> {
    const current = this.connections.get(serverId);
    if (current?.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.connections.delete(serverId);
    await this.prisma.server.update({
      where: { id: serverId },
      data: { status: "OFFLINE" }
    });
    this.realtime.broadcast({ type: "server.offline", payload: { serverId } });
  }
}
