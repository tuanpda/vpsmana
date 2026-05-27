import { FastifyRequest } from "fastify";
import { ServerConfig } from "./config";
import { hashToken } from "./security";

export type ApiRole = "ADMIN" | "OPERATOR" | "VIEWER";
export const SESSION_COOKIE_NAME = "vps_manager_session";

export interface AuthContext {
  role: ApiRole;
  label: string;
}

export function readAuthContext(request: FastifyRequest, config: ServerConfig): AuthContext | undefined {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;

  if ((token && token === config.adminToken) || isValidSessionCookie(request.headers.cookie, config)) {
    return {
      role: "ADMIN",
      label: token ? "admin-token" : "admin-session"
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

export function createSessionCookieValue(config: ServerConfig): string {
  return hashToken(`session:${config.adminToken}`);
}

export function isValidSessionCookie(cookieHeader: string | undefined, config: ServerConfig): boolean {
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] === createSessionCookieValue(config);
}

export function buildSessionCookie(config: ServerConfig): string {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${createSessionCookieValue(config)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`;
}

export function buildClearSessionCookie(config: ServerConfig): string {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) {
          return [part, ""];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      })
  );
}
