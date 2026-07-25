import jwt from "jsonwebtoken";

export type AuthRole = "admin";

export function signAuthToken(userId: string, role?: AuthRole): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  // role is omitted entirely for ordinary users -- only the fixed admin login sets it, and
  // the gateway only forwards X-User-Role when the claim is actually present
  return jwt.sign(role ? { sub: userId, role } : { sub: userId }, secret, { expiresIn: "30d" });
}

export function verifyAuthToken(token: string): { sub: string; role?: AuthRole } {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  return jwt.verify(token, secret) as { sub: string; role?: AuthRole };
}
