import { FastifyRequest } from "fastify";
import { ServerConfig } from "./config";

export type ApiRole = "ADMIN" | "OPERATOR" | "VIEWER";

export interface AuthContext {
  role: ApiRole;
  label: string;
}

export function readAuthContext(request: FastifyRequest, config: ServerConfig): AuthContext | undefined {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;

  if (token && token === config.adminToken) {
    return {
      role: "ADMIN",
      label: "admin-token"
    };
  }

  return undefined;
}

export function requireApiRole(request: FastifyRequest, config: ServerConfig, roles: ApiRole[]): AuthContext {
  const context = readAuthContext(request, config);

  if (!context || !roles.includes(context.role)) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }

  return context;
}

export function isAdminToken(token: string | null, config: ServerConfig): boolean {
  return Boolean(token && token === config.adminToken);
}
