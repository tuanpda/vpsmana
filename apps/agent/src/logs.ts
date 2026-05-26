import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface LogStreamRequest {
  streamId: string;
  service: {
    pm2Name: string;
  };
  lines?: number;
}

export interface LogOutput {
  streamId: string;
  pm2Name: string;
  chunk: string;
}

export class Pm2LogStreamer {
  private readonly streams = new Map<string, ChildProcessWithoutNullStreams>();

  start(request: LogStreamRequest, onOutput: (output: LogOutput) => void, onEnd: (streamId: string) => void): void {
    this.stop(request.streamId);

    const child = spawn(
      "pm2",
      ["logs", request.service.pm2Name, "--raw", "--lines", String(request.lines ?? 100)],
      {
        shell: false,
        windowsHide: true
      }
    );

    this.streams.set(request.streamId, child);
    child.stdout.on("data", (chunk: Buffer) => {
      onOutput({
        streamId: request.streamId,
        pm2Name: request.service.pm2Name,
        chunk: chunk.toString()
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      onOutput({
        streamId: request.streamId,
        pm2Name: request.service.pm2Name,
        chunk: chunk.toString()
      });
    });
    child.on("close", () => {
      this.streams.delete(request.streamId);
      onEnd(request.streamId);
    });
  }

  stop(streamId: string): void {
    const child = this.streams.get(streamId);

    if (!child) {
      return;
    }

    child.kill("SIGTERM");
    this.streams.delete(streamId);
  }

  stopAll(): void {
    for (const streamId of this.streams.keys()) {
      this.stop(streamId);
    }
  }
}
