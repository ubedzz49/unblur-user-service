import jwt from "jsonwebtoken";

export function signAuthToken(userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  return jwt.sign({ sub: userId }, secret, { expiresIn: "30d" });
}

export function verifyAuthToken(token: string): { sub: string } {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  return jwt.verify(token, secret) as { sub: string };
}
