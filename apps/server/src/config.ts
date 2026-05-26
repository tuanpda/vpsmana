export interface ServerConfig {
  port: number;
  publicUrl: string;
  adminToken: string;
}

export function loadConfig(): ServerConfig {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    throw new Error("ADMIN_TOKEN is required");
  }

  return {
    port: Number(process.env.PORT ?? 8080),
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8080",
    adminToken
  };
}
