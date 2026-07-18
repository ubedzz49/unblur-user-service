import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "./app.js";

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
