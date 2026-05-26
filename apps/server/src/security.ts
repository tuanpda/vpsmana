import crypto from "node:crypto";

const SECRET_PATTERN = /(token|password|passwd|secret|authorization|api[_-]?key)=([^\s&]+)/gi;

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function maskSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, "$1=[REDACTED]");
}
