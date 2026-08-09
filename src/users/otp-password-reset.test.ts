import bcrypt from "bcrypt";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryUserRepository } from "./repository.js";
import { InMemoryOtpStore } from "../otp/store.js";
import { RecordingEmailSender } from "../email/sender.js";
import { signAuthToken } from "../jwt.js";

const BCRYPT_COST_FACTOR = 12;

// extracts the 6-digit code out of the recorded email body ("Your verification code is 123456...")
function extractOtp(emailSender: RecordingEmailSender): string {
  const match = emailSender.sent.at(-1)?.text.match(/\d{6}/);
  if (!match) throw new Error("no otp found in recorded email");
  return match[0];
}

describe("POST /users/me/password/otp", () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });
  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  async function createUser(userRepo: InMemoryUserRepository, identifier = "student@example.com") {
    const { user } = await userRepo.findOrCreateByIdentifier(identifier, true);
    return user;
  }

  it("resets the password with a valid otp, no current password required", async () => {
    const userRepo = new InMemoryUserRepository();
    const emailSender = new RecordingEmailSender();
    const otpStore = new InMemoryOtpStore();
    const user = await createUser(userRepo);
    const hash = await bcrypt.hash("old-default-pass", BCRYPT_COST_FACTOR);
    userRepo.seedPassword(user.id, hash, true);

    const app = buildApp(otpStore, emailSender, userRepo);
    const authToken = signAuthToken(user.id);

    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/otp/send",
      payload: { identifier: "student@example.com" },
    });
    expect(sendRes.statusCode).toBe(200);
    const otp = extractOtp(emailSender);

    const resetRes = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { otp, newPassword: "brand-new-pass" },
    });

    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json()).toEqual({ ok: true });

    const info = await userRepo.findPasswordInfoById(user.id);
    expect(info?.mustResetPassword).toBe(false);
    expect(await bcrypt.compare("brand-new-pass", info!.passwordHash!)).toBe(true);
  });

  it("rejects an invalid or expired otp", async () => {
    const userRepo = new InMemoryUserRepository();
    const emailSender = new RecordingEmailSender();
    const otpStore = new InMemoryOtpStore();
    const user = await createUser(userRepo);

    const app = buildApp(otpStore, emailSender, userRepo);
    const authToken = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { otp: "000000", newPassword: "brand-new-pass" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid or expired otp" });
  });

  it("rejects a too-short newPassword before even checking the otp", async () => {
    const userRepo = new InMemoryUserRepository();
    const emailSender = new RecordingEmailSender();
    const otpStore = new InMemoryOtpStore();
    const user = await createUser(userRepo);

    const app = buildApp(otpStore, emailSender, userRepo);
    const authToken = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { otp: "123456", newPassword: "short" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("requires auth", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      payload: { otp: "123456", newPassword: "brand-new-pass" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("an otp cannot be reused for a second password reset", async () => {
    const userRepo = new InMemoryUserRepository();
    const emailSender = new RecordingEmailSender();
    const otpStore = new InMemoryOtpStore();
    const user = await createUser(userRepo);

    const app = buildApp(otpStore, emailSender, userRepo);
    const authToken = signAuthToken(user.id);

    await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "student@example.com" } });
    const otp = extractOtp(emailSender);

    const first = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { otp, newPassword: "brand-new-pass" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/users/me/password/otp",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { otp, newPassword: "another-new-pass" },
    });
    expect(second.statusCode).toBe(401);
  });
});
