import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryOtpStore } from "./otp/store.js";
import { RecordingEmailSender } from "./email/sender.js";
import { InMemoryUserRepository } from "./users/repository.js";
import { signAuthToken } from "./jwt.js";

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

describe("OTP verify links to a real user record", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("creates a user on first verify and reuses it on a second login", async () => {
    const userRepo = new InMemoryUserRepository();
    const otpStore = new InMemoryOtpStore();
    const app = buildApp(otpStore, new RecordingEmailSender(), userRepo);

    const send1 = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });
    const verify1 = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp: send1.json().otp },
    });
    const token1 = verify1.json().token;

    const send2 = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });
    const verify2 = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp: send2.json().otp },
    });
    const token2 = verify2.json().token;

    const me1 = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token1}` } });
    const me2 = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token2}` } });

    expect(me1.json().id).toBe(me2.json().id);
    expect(me1.json().phone).toBe("+911234567890");
  });
});

describe("GET /users/me", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: "Bearer garbage" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /users/me", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("updates the provided fields and leaves the rest untouched", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);

    const user = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Asha", bio: "Maths tutor" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Asha");
    expect(res.json().bio).toBe("Maths tutor");
    expect(res.json().email).toBe("student@example.com");
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "PATCH", url: "/users/me", payload: { name: "Asha" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /users/me/photo-upload-url", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("returns an upload url and a public url for an allowed content type", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);
    const user = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "image/png" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().uploadUrl).toBeTypeOf("string");
    expect(res.json().publicUrl).toBeTypeOf("string");
  });

  it("rejects an unsupported content type", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);
    const user = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "application/pdf" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      payload: { contentType: "image/png" },
    });
    expect(res.statusCode).toBe(401);
  });
});
