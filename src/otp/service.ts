import crypto from "node:crypto";
import { OtpStore } from "./store.js";

const OTP_TTL_SECONDS = 10 * 60;
const OTP_LENGTH = 6;

function hashOtp(otp: string, identifier: string): string {
  // salted with the identifier so a leaked hash isn't directly reusable elsewhere
  return crypto.createHash("sha256").update(`${identifier}:${otp}`).digest("hex");
}

function generateOtp(): string {
  const max = 10 ** OTP_LENGTH;
  return crypto.randomInt(0, max).toString().padStart(OTP_LENGTH, "0");
}

export class OtpService {
  constructor(private store: OtpStore) {}

  async send(identifier: string): Promise<{ otp: string }> {
    const otp = generateOtp();
    await this.store.set(this.key(identifier), hashOtp(otp, identifier), OTP_TTL_SECONDS);
    // caller decides whether to actually return this (dev-only) or dispatch via SMS/email provider
    return { otp };
  }

  async verify(identifier: string, otp: string): Promise<boolean> {
    const key = this.key(identifier);
    const storedHash = await this.store.get(key);
    if (!storedHash) return false;

    const matches = storedHash === hashOtp(otp, identifier);
    if (matches) await this.store.del(key);
    return matches;
  }

  private key(identifier: string): string {
    return `otp:${identifier}`;
  }
}
