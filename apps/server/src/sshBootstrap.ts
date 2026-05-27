import fs from "node:fs/promises";
import path from "node:path";
import { Client, ConnectConfig, SFTPWrapper } from "ssh2";
import { ServerConfig } from "./config";

export interface BootstrapVpsInput {
  name?: string;
  ipAddress: string;
  sshPort?: number;
  sshUser: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
  serviceUser?: string;
  installDir?: string;
  centralUrl?: string;
}

export interface BootstrapVpsResult {
  logs: string[];
  centralUrl: string;
  installDir: string;
  serviceUser: string;
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly logs: string[]
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

interface RemoteExecOptions {
  sshUser: string;
  sudoPassword?: string;
  label: string;
}

interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RuntimePaths {
  node: string;
  npm: string;
  pm2: string;
}

const AGENT_FILES = ["commands.js", "config.js", "index.js", "logs.js", "metrics.js", "pm2.js"];

export async function bootstrapVpsAgent(
  input: BootstrapVpsInput,
  agentToken: string,
  config: ServerConfig
): Promise<BootstrapVpsResult> {
  validateInput(input);

  const logs: string[] = [];
  const installDir = input.installDir?.trim() || "/opt/vps-manager-agent";
  const serviceUser = input.serviceUser?.trim() || input.sshUser.trim();
  const sshUser = input.sshUser.trim();
  const centralUrl = normalizeCentralUrl(input.centralUrl?.trim() || config.publicUrl);
  const sudoPassword = input.sudoPassword || input.password;
  const execBase: Omit<RemoteExecOptions, "label"> = {
    sshUser,
    sudoPassword
  };

  const conn = await connectSsh(input, logs);

  try {
    const agentDistDir = await assertAgentBuild();
    logs.push(`Connected to ${sshUser}@${input.ipAddress}:${input.sshPort ?? 22}`);

    await runStep(logs, "Create install directory", async () => {
      const script = `mkdir -p ${shellQuote(installDir)} && chown -R ${shellQuote(serviceUser)}:${shellQuote(serviceUser)} ${shellQuote(installDir)}`;
      if (sshUser === "root") {
        await runRemoteShell(conn, script, { ...execBase, label: "mkdir" });
      } else {
        await runRemoteRoot(conn, script, { ...execBase, label: "mkdir" });
      }
    });

    const sftp = await openSftp(conn);

    await runStep(logs, "Upload agent files", async () => {
      await uploadAgentBundle(sftp, agentDistDir, installDir);
    });

    const runtimePaths = await runStepWithValue(logs, "Detect node/npm/pm2 paths", () =>
      detectRuntimePaths(conn, sshUser, serviceUser, execBase)
    );
    logs.push(`Detected runtime: node=${runtimePaths.node}, npm=${runtimePaths.npm}, pm2=${runtimePaths.pm2}`);

    await runStep(logs, "Write systemd unit", async () => {
      await uploadSystemdService(sftp, installDir, {
        name: input.name?.trim() || input.ipAddress,
        token: agentToken,
        centralUrl,
        installDir,
        serviceUser,
        runtimePaths
      });
    });

    await runStep(logs, "Install agent dependencies", async () => {
      const installScript = `cd ${shellQuote(installDir)} && ${shellQuote(runtimePaths.npm)} install --omit=dev`;
      await runAsServiceUser(conn, sshUser, serviceUser, installScript, execBase, "npm install");
    });

    await runStep(logs, "Enable systemd service", async () => {
      const installServiceCommand = [
        `cp ${shellQuote(`${installDir}/vps-manager-agent.service`)} /etc/systemd/system/vps-manager-agent.service`,
        "systemctl daemon-reload",
        "systemctl enable vps-manager-agent",
        "systemctl restart vps-manager-agent",
        "systemctl --no-pager --full status vps-manager-agent | sed -n '1,14p'"
      ].join(" && ");

      if (sshUser === "root") {
        await runRemoteShell(conn, installServiceCommand, { ...execBase, label: "systemd" });
      } else {
        await runRemoteRoot(conn, installServiceCommand, { ...execBase, label: "systemd" });
      }
    });

    return {
      logs,
      centralUrl,
      installDir,
      serviceUser
    };
  } catch (error) {
    if (error instanceof BootstrapError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new BootstrapError(message, logs);
  } finally {
    conn.end();
  }
}

async function runStep(logs: string[], label: string, action: () => Promise<void>): Promise<void> {
  await runStepWithValue(logs, label, async () => {
    await action();
    return undefined;
  });
}

async function runStepWithValue<T>(logs: string[], label: string, action: () => Promise<T>): Promise<T> {
  logs.push(`[step] ${label}...`);

  try {
    const value = await action();
    logs.push(`[step] ${label} OK`);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BootstrapError(`Failed at "${label}": ${message}`, logs);
  }
}

function validateInput(input: BootstrapVpsInput): void {
  if (!input.ipAddress?.trim()) {
    throw new Error("VPS IP is required");
  }

  if (!input.sshUser?.trim()) {
    throw new Error("SSH user is required");
  }

  if (!input.password && !input.privateKey) {
    throw new Error("SSH password or private key is required");
  }
}

async function assertAgentBuild(): Promise<string> {
  const agentDistDir = path.resolve(process.cwd(), "dist/apps/agent/src");

  for (const file of AGENT_FILES) {
    try {
      await fs.access(path.join(agentDistDir, file));
    } catch {
      throw new Error("Agent build not found. Run `npm run build` on VPS Manager before bootstrapping.");
    }
  }

  return agentDistDir;
}

function connectSsh(input: BootstrapVpsInput, logs: string[]): Promise<Client> {
  const conn = new Client();
  const sshConfig: ConnectConfig = {
    host: input.ipAddress.trim(),
    port: input.sshPort ?? 22,
    username: input.sshUser.trim(),
    password: input.password || undefined,
    privateKey: input.privateKey || undefined,
    passphrase: input.passphrase || undefined,
    readyTimeout: 30_000,
    keepaliveInterval: 10_000
  };

  logs.push(`Connecting to ${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);

  return new Promise((resolve, reject) => {
    conn.once("ready", () => resolve(conn));
    conn.once("error", (error) => {
      reject(new Error(formatSshError(error)));
    });
    conn.connect(sshConfig);
  });
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(sftp);
    });
  });
}

async function uploadAgentBundle(sftp: SFTPWrapper, agentDistDir: string, installDir: string): Promise<void> {
  for (const file of AGENT_FILES) {
    await fastPut(sftp, path.join(agentDistDir, file), `${installDir}/${file}`);
  }

  await writeRemoteFile(sftp, `${installDir}/package.json`, buildRemotePackageJson());
}

async function uploadSystemdService(
  sftp: SFTPWrapper,
  installDir: string,
  options: {
    name: string;
    token: string;
    centralUrl: string;
    installDir: string;
    serviceUser: string;
    runtimePaths: RuntimePaths;
  }
): Promise<void> {
  await writeRemoteFile(sftp, `${installDir}/vps-manager-agent.service`, buildSystemdService(options));
}

function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function writeRemoteFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, content, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function runAsServiceUser(
  conn: Client,
  sshUser: string,
  serviceUser: string,
  script: string,
  options: Omit<RemoteExecOptions, "label">,
  label: string
): Promise<void> {
  if (sshUser === serviceUser) {
    await runRemoteShell(conn, script, { ...options, label });
    return;
  }

  if (sshUser === "root") {
    await runRemoteShell(
      conn,
      `sudo -iu ${shellQuote(serviceUser)} bash -ilc ${shellQuote(script)}`,
      { ...options, label }
    );
    return;
  }

  await runRemoteRoot(
    conn,
    `sudo -iu ${shellQuote(serviceUser)} bash -ilc ${shellQuote(script)}`,
    { ...options, label }
  );
}

async function detectRuntimePaths(
  conn: Client,
  sshUser: string,
  serviceUser: string,
  options: Omit<RemoteExecOptions, "label">
): Promise<RuntimePaths> {
  const probe = "command -v node && command -v npm && command -v pm2";
  let result: RemoteExecResult;

  if (sshUser === serviceUser) {
    result = await runRemoteShell(conn, probe, { ...options, label: "detect-runtime" });
  } else if (sshUser === "root") {
    result = await runRemoteShell(
      conn,
      `sudo -iu ${shellQuote(serviceUser)} bash -ilc ${shellQuote(probe)}`,
      { ...options, label: "detect-runtime" }
    );
  } else {
    result = await runRemoteRoot(
      conn,
      `sudo -iu ${shellQuote(serviceUser)} bash -ilc ${shellQuote(probe)}`,
      { ...options, label: "detect-runtime" }
    );
  }

  const [node, npm, pm2] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!node || !npm || !pm2) {
    throw new Error(
      `Could not detect node/npm/pm2 for user ${serviceUser}. stdout=${result.stdout.trim() || "(empty)"} stderr=${result.stderr.trim() || "(empty)"}`
    );
  }

  return { node, npm, pm2 };
}

function runRemoteShell(conn: Client, script: string, options: RemoteExecOptions): Promise<RemoteExecResult> {
  return runRemote(conn, `bash -ilc ${shellQuote(script)}`, {
    useSudo: false,
    pty: false,
    ...options
  });
}

function runRemoteRoot(conn: Client, script: string, options: RemoteExecOptions): Promise<RemoteExecResult> {
  if (options.sshUser === "root") {
    return runRemoteShell(conn, script, options);
  }

  return runRemote(conn, `sudo -S -p "" bash -ilc ${shellQuote(script)}`, {
    useSudo: true,
    pty: true,
    ...options
  });
}

function runRemote(
  conn: Client,
  command: string,
  options: RemoteExecOptions & { useSudo: boolean; pty: boolean }
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: options.pty }, (error, stream) => {
      if (error) {
        reject(new Error(`[${options.label}] ${error.message}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let passwordSent = false;

      const sendSudoPassword = () => {
        if (!options.useSudo || passwordSent || !options.sudoPassword) {
          return;
        }

        passwordSent = true;
        stream.write(`${options.sudoPassword}\n`);
      };

      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        if (options.useSudo && /password|sudo/i.test(text)) {
          sendSudoPassword();
        }
      });

      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      stream.on("close", (code: number | null) => {
        const exitCode = code ?? 0;

        if (exitCode !== 0) {
          const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ") || "(no output)";
          reject(
            new Error(
              `[${options.label}] exit ${exitCode}: ${detail}\nCommand: ${command}`
            )
          );
          return;
        }

        resolve({ stdout, stderr, code: exitCode });
      });

      if (options.useSudo) {
        setTimeout(sendSudoPassword, 100);
      }
    });
  });
}

function formatSshError(error: Error): string {
  if (error.message.includes("All configured authentication methods failed")) {
    return "SSH login failed. Check IP, port, username, password/private key.";
  }

  return error.message;
}

function normalizeCentralUrl(value: string): string {
  if (value.startsWith("https://")) {
    return `wss://${value.slice("https://".length).replace(/\/$/, "")}`;
  }

  if (value.startsWith("http://")) {
    return `ws://${value.slice("http://".length).replace(/\/$/, "")}`;
  }

  return value.replace(/\/$/, "");
}

function buildRemotePackageJson(): string {
  return `${JSON.stringify(
    {
      name: "vps-manager-agent-runtime",
      version: "0.1.0",
      private: true,
      scripts: {
        start: "node index.js"
      },
      dependencies: {
        dotenv: "latest",
        systeminformation: "latest",
        ws: "latest"
      }
    },
    null,
    2
  )}\n`;
}

function buildSystemdService(options: {
  name: string;
  token: string;
  centralUrl: string;
  installDir: string;
  serviceUser: string;
  runtimePaths: RuntimePaths;
}): string {
  const nodeDir = path.posix.dirname(options.runtimePaths.node);

  return `[Unit]
Description=VPS Manager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.installDir}
Environment="NODE_ENV=production"
Environment="CENTRAL_URL=${systemdEscape(options.centralUrl)}"
Environment="AGENT_TOKEN=${systemdEscape(options.token)}"
Environment="AGENT_NAME=${systemdEscape(options.name)}"
Environment="HEARTBEAT_INTERVAL_MS=15000"
Environment="PATH=${systemdEscape(`${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)}"
ExecStart=/bin/bash -ilc "cd ${systemdEscape(options.installDir)} && exec ${systemdEscape(options.runtimePaths.node)} index.js"
Restart=always
RestartSec=5
User=${options.serviceUser}

[Install]
WantedBy=multi-user.target
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function systemdEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
