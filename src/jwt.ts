import jwt from "jsonwebtoken";

export function signAuthToken(identifier: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  // subject is the phone/email used at OTP verify time -- until A2 lands there's no
  // users table to link to yet, so this token only proves "this identifier is verified"
  return jwt.sign({ sub: identifier }, secret, { expiresIn: "30d" });
}
