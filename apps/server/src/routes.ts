import { CommandAction, PrismaClient } from "@prisma/client";
import { FastifyInstance } from "fastify";
import { AgentGateway } from "./agentGateway";
import { ServerConfig } from "./config";
import { buildClearSessionCookie, buildSessionCookie, isAdminToken, readAuthContext, requireApiRole } from "./auth";
import { generateToken, hashToken } from "./security";
import { bootstrapVpsAgent, BootstrapVpsInput } from "./sshBootstrap";
import { toJsonSafe } from "./json";

const ACTIONS_REQUIRING_SERVICE = new Set<CommandAction>([
  "PM2_START",
  "PM2_STOP",
  "PM2_RESTART",
  "PM2_RELOAD",
  "GIT_PULL",
  "NPM_INSTALL",
  "NPM_BUILD",
  "DEPLOY"
]);

interface CreateServerBody {
  name?: string;
  hostname?: string;
  ipAddress?: string;
}

interface BootstrapServerBody extends BootstrapVpsInput {}

interface ServiceActionBody {
  action?: CommandAction;
  timeoutMs?: number;
}

interface LogStreamBody {
  lines?: number;
}

interface LoginBody {
  token?: string;
}

export function registerRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ServerConfig,
  agentGateway: AgentGateway
): void {
  app.get("/api/health", async () => ({
    ok: true,
    at: new Date().toISOString()
  }));

  app.get("/api/session", async (request) => ({
    authenticated: Boolean(readAuthContext(request, config))
  }));

  app.post<{ Body: LoginBody }>("/api/login", async (request, reply) => {
    const token = request.body?.token?.trim() ?? "";

    if (!isAdminToken(token, config)) {
      return reply.code(401).send({ error: "Invalid ADMIN_TOKEN" });
    }

    reply.header("Set-Cookie", buildSessionCookie(config));
    return { ok: true };
  });

  app.post("/api/logout", async (_request, reply) => {
    reply.header("Set-Cookie", buildClearSessionCookie(config));
    return { ok: true };
  });

  app.get("/api/servers", async (request) => {
    requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);

    const data = await prisma.server.findMany({
      orderBy: { name: "asc" },
      include: {
        services: {
          orderBy: { name: "asc" }
        },
        metrics: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    return toJsonSafe(data);
  });

  app.post<{ Body: CreateServerBody }>("/api/servers", async (request, reply) => {
    const actor = requireApiRole(request, config, ["ADMIN"]);
    const token = generateToken();
    const body = request.body ?? {};
    const name = body.name?.trim() || body.hostname?.trim() || "new-vps";

    const server = await prisma.server.create({
      data: {
        name,
        hostname: body.hostname,
        ipAddress: body.ipAddress,
        agentTokenHash: hashToken(token),
        audits: {
          create: {
            action: "server.create",
            entity: "server",
            metadata: {
              actor: actor.label
            },
            ipAddress: request.ip
          }
        }
      }
    });

    return reply.code(201).send(toJsonSafe({
      server,
      agentToken: token
    }));
  });

  app.post<{ Body: BootstrapServerBody }>("/api/servers/bootstrap", async (request, reply) => {
    const actor = requireApiRole(request, config, ["ADMIN"]);
    const body = request.body ?? ({} as BootstrapServerBody);

    if (!body.ipAddress?.trim() || !body.sshUser?.trim() || (!body.password && !body.privateKey)) {
      return reply.code(400).send({
        error: "ipAddress, sshUser and either password or privateKey are required"
      });
    }

    const token = generateToken();
    const name = body.name?.trim() || body.ipAddress?.trim() || "new-vps";

    const server = await prisma.server.create({
      data: {
        name,
        hostname: body.name,
        ipAddress: body.ipAddress,
        agentTokenHash: hashToken(token),
        audits: {
          create: {
            action: "server.bootstrap.start",
            entity: "server",
            metadata: {
              actor: actor.label,
              sshPort: body.sshPort ?? 22,
              sshUser: body.sshUser,
              serviceUser: body.serviceUser || body.sshUser
            },
            ipAddress: request.ip
          }
        }
      }
    });

    try {
      const result = await bootstrapVpsAgent(body, token, config);

      await prisma.auditLog.create({
        data: {
          action: "server.bootstrap.success",
          entity: "server",
          entityId: server.id,
          serverId: server.id,
          metadata: {
            actor: actor.label,
            installDir: result.installDir,
            serviceUser: result.serviceUser,
            centralUrl: result.centralUrl
          },
          ipAddress: request.ip
        }
      });

      return reply.code(201).send(
        toJsonSafe({
          server,
          logs: result.logs,
          message: "VPS agent installed. Wait for the first heartbeat, then refresh the dashboard."
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await prisma.auditLog.create({
        data: {
          action: "server.bootstrap.failed",
          entity: "server",
          entityId: server.id,
          serverId: server.id,
          metadata: {
            actor: actor.label,
            error: message
          },
          ipAddress: request.ip
        }
      });

      return reply.code(500).send({
        error: message,
        serverId: server.id
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (request) => {
    requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);

    const data = await prisma.server.findUniqueOrThrow({
      where: { id: request.params.id },
      include: {
        services: { orderBy: { name: "asc" } },
        metrics: { orderBy: { createdAt: "desc" }, take: 120 },
        commands: { orderBy: { createdAt: "desc" }, take: 50 }
      }
    });

    return toJsonSafe(data);
  });

  app.get("/api/services", async (request) => {
    requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);

    const data = await prisma.service.findMany({
      orderBy: [{ server: { name: "asc" } }, { name: "asc" }],
      include: {
        server: true
      }
    });

    return toJsonSafe(data);
  });

  app.get<{ Params: { id: string } }>("/api/services/:id", async (request) => {
    requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);

    const data = await prisma.service.findUniqueOrThrow({
      where: { id: request.params.id },
      include: {
        server: true,
        commands: { orderBy: { createdAt: "desc" }, take: 100 },
        deployments: { orderBy: { createdAt: "desc" }, take: 20 }
      }
    });

    return toJsonSafe(data);
  });

  app.post<{ Params: { id: string }; Body: ServiceActionBody }>("/api/services/:id/actions", async (request, reply) => {
    const actor = requireApiRole(request, config, ["ADMIN", "OPERATOR"]);
    const body = request.body ?? {};
    const action = body.action;

    if (!action || !ACTIONS_REQUIRING_SERVICE.has(action)) {
      return reply.code(400).send({ error: "Unsupported action" });
    }

    const service = await prisma.service.findUniqueOrThrow({
      where: { id: request.params.id },
      include: { server: true }
    });

    const command = await prisma.command.create({
      data: {
        serverId: service.serverId,
        serviceId: service.id,
        action,
        cwd: service.sourcePath,
        args: {
          timeoutMs: body.timeoutMs
        }
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "command.create",
        entity: "command",
        entityId: command.id,
        serverId: service.serverId,
        metadata: {
          actor: actor.label,
          serviceId: service.id,
          action
        },
        ipAddress: request.ip
      }
    });

    if (action === "DEPLOY") {
      await prisma.deployment.create({
        data: {
          serviceId: service.id,
          commandId: command.id,
          branch: service.branch,
          fromCommit: service.commitSha
        }
      });
    }

    const dispatched = agentGateway.sendCommand(service.serverId, {
      commandId: command.id,
      action,
      service: {
        id: service.id,
        pm2Name: service.pm2Name,
        sourcePath: service.sourcePath
      },
      timeoutMs: body.timeoutMs
    });

    if (!dispatched) {
      const failed = await prisma.command.update({
        where: { id: command.id },
        data: {
          status: "FAILED",
          errorMessage: "Agent is offline",
          finishedAt: new Date()
        }
      });
      return reply.code(409).send(toJsonSafe(failed));
    }

    return reply.code(202).send(toJsonSafe(command));
  });

  app.post<{ Params: { id: string }; Body: LogStreamBody }>("/api/services/:id/logs/stream", async (request, reply) => {
    const actor = requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);
    const service = await prisma.service.findUniqueOrThrow({
      where: { id: request.params.id },
      include: { server: true }
    });
    const streamId = `${service.id}-${Date.now()}`;
    const dispatched = agentGateway.startLogStream(service.serverId, {
      streamId,
      service: {
        pm2Name: service.pm2Name
      },
      lines: request.body?.lines ?? 100
    });

    await prisma.auditLog.create({
      data: {
        action: "log.stream",
        entity: "service",
        entityId: service.id,
        serverId: service.serverId,
        metadata: {
          actor: actor.label,
          pm2Name: service.pm2Name
        },
        ipAddress: request.ip
      }
    });

    if (!dispatched) {
      return reply.code(409).send({ error: "Agent is offline" });
    }

    return reply.code(202).send({ streamId });
  });

  app.post<{ Params: { serverId: string; streamId: string } }>(
    "/api/servers/:serverId/logs/:streamId/stop",
    async (request, reply) => {
      requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);
      const dispatched = agentGateway.stopLogStream(request.params.serverId, request.params.streamId);

      if (!dispatched) {
        return reply.code(409).send({ error: "Agent is offline" });
      }

      return reply.code(202).send({ ok: true });
    }
  );

  app.get("/api/commands", async (request) => {
    requireApiRole(request, config, ["ADMIN", "OPERATOR", "VIEWER"]);

    const data = await prisma.command.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        server: true,
        service: true
      }
    });

    return toJsonSafe(data);
  });

  app.get("/api/audit-logs", async (request) => {
    requireApiRole(request, config, ["ADMIN"]);

    const data = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        server: true,
        user: true
      }
    });

    return toJsonSafe(data);
  });
}
