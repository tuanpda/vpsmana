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

interface RemoteExecOptions {
  sudo?: boolean;
  sudoPassword?: string;
  username: string;
}

interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number;
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
  const centralUrl = normalizeCentralUrl(input.centralUrl?.trim() || config.publicUrl);
  const conn = await connectSsh(input, logs);

  try {
    const agentDistDir = await assertAgentBuild();
    logs.push(`Connected to ${input.sshUser}@${input.ipAddress}:${input.sshPort ?? 22}`);

    await runRemote(conn, `mkdir -p ${shellQuote(installDir)} && chown -R ${shellQuote(serviceUser)}:${shellQuote(serviceUser)} ${shellQuote(installDir)}`, {
      sudo: input.sshUser !== "root",
      sudoPassword: input.sudoPassword || input.password,
      username: input.sshUser
    });
    logs.push(`Prepared ${installDir}`);

    const sftp = await openSftp(conn);
    await uploadAgentBundle(sftp, agentDistDir, installDir, {
      name: input.name?.trim() || input.ipAddress,
      token: agentToken,
      centralUrl,
      installDir,
      serviceUser
    });
    logs.push("Uploaded agent bundle");

    await runRemote(conn, `chown -R ${shellQuote(serviceUser)}:${shellQuote(serviceUser)} ${shellQuote(installDir)}`, {
      sudo: input.sshUser !== "root",
      sudoPassword: input.sudoPassword || input.password,
      username: input.sshUser
    });

    const installDependenciesCommand =
      serviceUser === "root"
        ? `cd ${shellQuote(installDir)} && npm install --omit=dev`
        : `sudo -u ${shellQuote(serviceUser)} -H bash -lc ${shellQuote(`cd ${shellQuote(installDir)} && npm install --omit=dev`)}`;

    await runRemote(conn, installDependenciesCommand, {
      sudo: input.sshUser !== "root",
      sudoPassword: input.sudoPassword || input.password,
      username: input.sshUser
    });
    logs.push("Installed agent dependencies on VPS");

    const installServiceCommand = [
      `cp ${shellQuote(`${installDir}/vps-manager-agent.service`)} /etc/systemd/system/vps-manager-agent.service`,
      "systemctl daemon-reload",
      "systemctl enable vps-manager-agent",
      "systemctl restart vps-manager-agent",
      "systemctl --no-pager --full status vps-manager-agent | sed -n '1,14p'"
    ].join(" && ");
    const status = await runRemote(conn, installServiceCommand, {
      sudo: input.sshUser !== "root",
      sudoPassword: input.sudoPassword || input.password,
      username: input.sshUser
    });
    logs.push(status.stdout.trim() || "Started vps-manager-agent service");

    return {
      logs,
      centralUrl,
      installDir,
      serviceUser
    };
  } finally {
    conn.end();
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
      throw new Error("Agent build not found. Run `npm run build` before bootstrapping a VPS.");
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
    conn.once("error", reject);
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

async function uploadAgentBundle(
  sftp: SFTPWrapper,
  agentDistDir: string,
  installDir: string,
  options: {
    name: string;
    token: string;
    centralUrl: string;
    installDir: string;
    serviceUser: string;
  }
): Promise<void> {
  for (const file of AGENT_FILES) {
    await fastPut(sftp, path.join(agentDistDir, file), `${installDir}/${file}`);
  }

  await writeRemoteFile(sftp, `${installDir}/package.json`, buildRemotePackageJson());
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

function runRemote(conn: Client, script: string, options: RemoteExecOptions): Promise<RemoteExecResult> {
  const command =
    options.sudo && options.username !== "root"
      ? `sudo -S -p "" bash -lc ${shellQuote(script)}`
      : `bash -lc ${shellQuote(script)}`;

  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: Boolean(options.sudo) }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      if (options.sudo && options.sudoPassword) {
        stream.write(`${options.sudoPassword}\n`);
      }

      stream.on("close", (code: number | null) => {
        const exitCode = code ?? 0;

        if (exitCode !== 0) {
          reject(new Error(`Remote command failed (${exitCode}): ${stderr || stdout || script}`));
          return;
        }

        resolve({ stdout, stderr, code: exitCode });
      });
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    });
  });
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
}): string {
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
ExecStart=/bin/bash -lc "cd ${systemdEscape(options.installDir)} && exec node index.js"
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
