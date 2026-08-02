import jwt from "jsonwebtoken";

export type AuthRole = "admin" | "superadmin";

export function signAuthToken(userId: string, role?: AuthRole, username?: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  // role/username are omitted entirely for ordinary users -- only a real admin_users login sets
  // them, and the gateway only forwards X-User-Role when the role claim is actually present.
  // username is embedded so audit-log entries don't need a DB round trip per action to resolve
  // "which admin did this" back to a human-readable name.
  const claims: Record<string, unknown> = { sub: userId };
  if (role) claims.role = role;
  if (username) claims.username = username;
  return jwt.sign(claims, secret, { expiresIn: "30d" });
}

export function verifyAuthToken(token: string): { sub: string; role?: AuthRole; username?: string } {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  return jwt.verify(token, secret) as { sub: string; role?: AuthRole; username?: string };
}
