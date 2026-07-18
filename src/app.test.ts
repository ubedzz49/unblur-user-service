import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryOtpStore } from "./otp/store.js";
import { RecordingEmailSender } from "./email/sender.js";

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("OTP auth flow", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  it("send -> verify -> returns a jwt", async () => {
    const app = buildApp();

    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/otp/send",
      payload: { identifier: "+911234567890" },
    });
    expect(sendRes.statusCode).toBe(200);
    const { otp } = sendRes.json();
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().token).toBeTypeOf("string");
  });

  it("rejects verify with wrong otp", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911111111111" } });

    const res = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911111111111", otp: "000000" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects send with no identifier", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/auth/otp/send", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("OTP via email", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("sends the otp by email instead of returning it, and verify still works", async () => {
    const otpStore = new InMemoryOtpStore();
    const emailSender = new RecordingEmailSender();
    const app = buildApp(otpStore, emailSender);

    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/otp/send",
      payload: { identifier: "student@example.com" },
    });
    expect(sendRes.statusCode).toBe(200);
    expect(sendRes.json()).toEqual({ sent: true });
    expect(sendRes.json().otp).toBeUndefined();

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe("student@example.com");
    const otp = emailSender.sent[0].text.match(/\d{6}/)?.[0];
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "student@example.com", otp },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().token).toBeTypeOf("string");
  });

  it("does not email a phone identifier", async () => {
    const emailSender = new RecordingEmailSender();
    const app = buildApp(new InMemoryOtpStore(), emailSender);

    await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });

    expect(emailSender.sent).toHaveLength(0);
  });
});
