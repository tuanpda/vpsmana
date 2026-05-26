import { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { ServerConfig } from "./config";
import { isAdminToken } from "./auth";

export interface RealtimeEvent {
  type: string;
  payload: unknown;
}

export class RealtimeHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly config: ServerConfig) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");

    if (!isAdminToken(token, this.config)) {
      socket.close(1008, "Unauthorized");
      return;
    }

    this.clients.add(socket);
    socket.send(JSON.stringify({ type: "connected", payload: { at: new Date().toISOString() } }));
    socket.on("close", () => this.clients.delete(socket));
  }

  broadcast(event: RealtimeEvent): void {
    const encoded = JSON.stringify(event);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    }
  }
}
