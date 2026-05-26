import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Pm2ServiceSnapshot {
  pm2Name: string;
  name: string;
  pid?: number;
  status: string;
  cpuPercent?: number;
  memoryBytes?: number;
  restartCount?: number;
  uptimeMs?: number;
  sourcePath?: string;
  execPath?: string;
}

interface RawPm2Process {
  name?: string;
  pid?: number;
  monit?: {
    cpu?: number;
    memory?: number;
  };
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
    pm_cwd?: string;
    pm_exec_path?: string;
  };
}

export async function listPm2Services(): Promise<Pm2ServiceSnapshot[]> {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024
    });
    const processes = JSON.parse(stdout) as RawPm2Process[];
    const now = Date.now();

    return processes
      .filter((processInfo) => processInfo.name)
      .map((processInfo) => ({
        pm2Name: processInfo.name as string,
        name: processInfo.name as string,
        pid: processInfo.pid,
        status: processInfo.pm2_env?.status ?? "unknown",
        cpuPercent: processInfo.monit?.cpu,
        memoryBytes: processInfo.monit?.memory,
        restartCount: processInfo.pm2_env?.restart_time,
        uptimeMs: processInfo.pm2_env?.pm_uptime ? now - processInfo.pm2_env.pm_uptime : undefined,
        sourcePath: processInfo.pm2_env?.pm_cwd,
        execPath: processInfo.pm2_env?.pm_exec_path
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read PM2 process list: ${message}`);
    return [];
  }
}
