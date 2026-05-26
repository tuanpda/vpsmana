import WebSocket from "ws";
import { AgentCommand, runAllowedCommand } from "./commands";
import { loadConfig } from "./config";
import { Pm2LogStreamer, LogStreamRequest } from "./logs";
import { collectIdentity, collectMetrics } from "./metrics";
import { listPm2Services } from "./pm2";

type ServerMessage =
  | {
      type: "command";
      payload: AgentCommand;
    }
  | {
      type: "startLog";
      payload: LogStreamRequest;
    }
  | {
      type: "stopLog";
      payload: { streamId: string };
    }
  | {
      type: "ping";
    };

const config = loadConfig();
let socket: WebSocket | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
const logStreamer = new Pm2LogStreamer();

function connect(): void {
  const url = new URL("/agent", config.centralUrl);
  url.searchParams.set("token", config.agentToken);
  url.searchParams.set("name", config.agentName);

  socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(`Connected to central server: ${config.centralUrl}`);
    void sendHeartbeat();
    heartbeatTimer = setInterval(() => void sendHeartbeat(), config.heartbeatIntervalMs);
  });

  socket.on("message", (raw) => {
    void handleMessage(raw.toString());
  });

  socket.on("close", () => {
    cleanupConnection();
    scheduleReconnect();
  });

  socket.on("error", (error) => {
    console.error(`Central connection error: ${error.message}`);
  });
}

async function sendHeartbeat(): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const [identity, metrics, services] = await Promise.all([collectIdentity(), collectMetrics(), listPm2Services()]);
    send({
      type: "heartbeat",
      payload: {
        identity,
        metrics,
        services
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Heartbeat failed: ${message}`);
  }
}

async function handleMessage(raw: string): Promise<void> {
  let message: ServerMessage;
  try {
    message = JSON.parse(raw) as ServerMessage;
  } catch {
    console.warn("Ignored invalid JSON message from central server");
    return;
  }

  if (message.type === "ping") {
    send({ type: "pong" });
    return;
  }

  if (message.type === "command") {
    await handleCommand(message.payload);
    return;
  }

  if (message.type === "startLog") {
    logStreamer.start(
      message.payload,
      (output) => send({ type: "logOutput", payload: output }),
      (streamId) => send({ type: "logEnded", payload: { streamId } })
    );
    return;
  }

  if (message.type === "stopLog") {
    logStreamer.stop(message.payload.streamId);
  }
}

async function handleCommand(command: AgentCommand): Promise<void> {
  send({ type: "commandStarted", payload: { commandId: command.commandId } });

  try {
    const result = await runAllowedCommand(command, (output) => {
      send({
        type: "commandOutput",
        payload: {
          commandId: command.commandId,
          ...output
        }
      });
    });

    send({
      type: "commandFinished",
      payload: {
        commandId: command.commandId,
        ...result
      }
    });
    await sendHeartbeat();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "commandFinished",
      payload: {
        commandId: command.commandId,
        status: "FAILED",
        errorMessage: message
      }
    });
  }
}

function send(message: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function cleanupConnection(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 5_000);
}

process.on("SIGINT", () => {
  cleanupConnection();
  logStreamer.stopAll();
  socket?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanupConnection();
  logStreamer.stopAll();
  socket?.close();
  process.exit(0);
});

connect();
