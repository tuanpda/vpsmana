import { spawn } from "node:child_process";

export type CommandAction =
  | "PM2_START"
  | "PM2_STOP"
  | "PM2_RESTART"
  | "PM2_RELOAD"
  | "PM2_DELETE"
  | "GIT_PULL"
  | "NPM_INSTALL"
  | "NPM_BUILD"
  | "DEPLOY"
  | "MANAGER_PULL_RESTART";

export interface AgentCommand {
  commandId: string;
  action: CommandAction;
  service?: {
    id: string;
    pm2Name: string;
    sourcePath?: string | null;
  };
  timeoutMs?: number;
}

export interface CommandOutput {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface CommandResult {
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT";
  exitCode?: number;
  errorMessage?: string;
}

type OutputHandler = (output: CommandOutput) => void;

interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export async function runAllowedCommand(command: AgentCommand, onOutput: OutputHandler): Promise<CommandResult> {
  const specs = buildCommandSpecs(command);

  for (const spec of specs) {
    const result = await runSpawnSpec(spec, onOutput);
    if (result.status !== "SUCCEEDED") {
      return result;
    }
  }

  return { status: "SUCCEEDED", exitCode: 0 };
}

function buildCommandSpecs(command: AgentCommand): SpawnSpec[] {
  const service = command.service;
  const timeoutMs = command.timeoutMs ?? 120_000;

  switch (command.action) {
    case "PM2_START":
      requirePm2Name(service);
      return [{ command: "pm2", args: ["start", service.pm2Name], timeoutMs }];
    case "PM2_STOP":
      requirePm2Name(service);
      return [{ command: "pm2", args: ["stop", service.pm2Name], timeoutMs }];
    case "PM2_RESTART":
      requirePm2Name(service);
      return [{ command: "pm2", args: ["restart", service.pm2Name], timeoutMs }];
    case "PM2_RELOAD":
      requirePm2Name(service);
      return [{ command: "pm2", args: ["reload", service.pm2Name], timeoutMs }];
    case "PM2_DELETE":
      requirePm2Name(service);
      return [{ command: "pm2", args: ["delete", service.pm2Name], timeoutMs }];
    case "GIT_PULL":
      requireSourcePath(service);
      return [{ command: "git", args: ["pull", "--ff-only"], cwd: service.sourcePath, timeoutMs }];
    case "NPM_INSTALL":
      requireSourcePath(service);
      return [{ command: "npm", args: ["install"], cwd: service.sourcePath, timeoutMs: 10 * 60_000 }];
    case "NPM_BUILD":
      requireSourcePath(service);
      return [{ command: "npm", args: ["run", "build"], cwd: service.sourcePath, timeoutMs: 10 * 60_000 }];
    case "DEPLOY":
      requirePm2Name(service);
      requireSourcePath(service);
      return [
        { command: "git", args: ["pull", "--ff-only"], cwd: service.sourcePath, timeoutMs },
        { command: "npm", args: ["install"], cwd: service.sourcePath, timeoutMs: 10 * 60_000 },
        { command: "npm", args: ["run", "build"], cwd: service.sourcePath, timeoutMs: 10 * 60_000 },
        { command: "pm2", args: ["restart", service.pm2Name], timeoutMs }
      ];
    case "MANAGER_PULL_RESTART":
      requirePm2Name(service);
      requireSourcePath(service);
      return [
        { command: "git", args: ["pull", "--ff-only"], cwd: service.sourcePath, timeoutMs },
        { command: "pm2", args: ["restart", service.pm2Name], timeoutMs }
      ];
  }
}

function requirePm2Name(service: AgentCommand["service"]): asserts service is NonNullable<AgentCommand["service"]> {
  if (!service?.pm2Name) {
    throw new Error("Service pm2Name is required for this command");
  }
}

function requireSourcePath(
  service: AgentCommand["service"]
): asserts service is NonNullable<AgentCommand["service"]> & { sourcePath: string } {
  if (!service?.sourcePath) {
    throw new Error("Service sourcePath is required for this command");
  }
}

function runSpawnSpec(spec: SpawnSpec, onOutput: OutputHandler): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      shell: false,
      windowsHide: true
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: "TIMED_OUT", errorMessage: `Command timed out after ${spec.timeoutMs}ms` });
    }, spec.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => onOutput({ stream: "stdout", chunk: chunk.toString() }));
    child.stderr.on("data", (chunk: Buffer) => onOutput({ stream: "stderr", chunk: chunk.toString() }));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: "FAILED", errorMessage: error.message });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        status: code === 0 ? "SUCCEEDED" : "FAILED",
        exitCode: code ?? undefined
      });
    });
  });
}
