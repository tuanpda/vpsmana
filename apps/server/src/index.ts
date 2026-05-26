import path from "node:path";
import cors from "@fastify/cors";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import { AgentGateway } from "./agentGateway";
import { db } from "./db";
import { loadConfig } from "./config";
import { RealtimeHub } from "./realtime";
import { registerRoutes } from "./routes";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = fastify({
    logger: true
  });
  const realtime = new RealtimeHub(config);
  const agentGateway = new AgentGateway(db, realtime);
  const agentWss = new WebSocketServer({ noServer: true });
  const uiWss = new WebSocketServer({ noServer: true });

  await app.register(cors, {
    origin: true
  });
  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../public"),
    prefix: "/"
  });

  registerRoutes(app, db, config, agentGateway);

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        void agentGateway.handleConnection(ws, request);
      });
      return;
    }

    if (url.pathname === "/ui") {
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        realtime.handleConnection(ws, request);
      });
      return;
    }

    socket.destroy();
  });

  await app.listen({
    host: "0.0.0.0",
    port: config.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
