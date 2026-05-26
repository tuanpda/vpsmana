import os from "node:os";
import si from "systeminformation";

export interface ServerMetricSnapshot {
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
}

export interface ServerIdentitySnapshot {
  hostname: string;
  os: string;
  architecture: string;
  ipAddress?: string;
}

export async function collectIdentity(): Promise<ServerIdentitySnapshot> {
  const [osInfo, networkInterfaces] = await Promise.all([si.osInfo(), si.networkInterfaces()]);
  const firstExternal = networkInterfaces.find((item) => !item.internal && item.ip4);

  return {
    hostname: os.hostname(),
    os: `${osInfo.distro} ${osInfo.release}`.trim(),
    architecture: os.arch(),
    ipAddress: firstExternal?.ip4
  };
}

export async function collectMetrics(): Promise<ServerMetricSnapshot> {
  const [load, memory, disks, networkStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats()
  ]);
  const rootDisk = disks.sort((a, b) => b.size - a.size)[0];
  const networkTotals = networkStats.reduce(
    (totals, item) => ({
      rx: totals.rx + item.rx_bytes,
      tx: totals.tx + item.tx_bytes
    }),
    { rx: 0, tx: 0 }
  );
  const [load1, load5, load15] = os.loadavg();

  return {
    cpuPercent: load.currentLoad,
    load1,
    load5,
    load15,
    memoryTotal: memory.total,
    memoryUsed: memory.active,
    diskTotal: rootDisk?.size,
    diskUsed: rootDisk?.used,
    diskPercent: rootDisk?.use,
    networkRxBytes: networkTotals.rx,
    networkTxBytes: networkTotals.tx,
    uptimeSeconds: os.uptime()
  };
}
