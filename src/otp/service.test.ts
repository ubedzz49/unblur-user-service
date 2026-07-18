import { describe, expect, it } from "vitest";
import { OtpService } from "./service.js";
import { InMemoryOtpStore } from "./store.js";

describe("OtpService", () => {
  it("verifies a correct otp and consumes it", async () => {
    const service = new OtpService(new InMemoryOtpStore());
    const { otp } = await service.send("+911234567890");

    expect(await service.verify("+911234567890", otp)).toBe(true);
    // consumed -- second verify with the same code must fail
    expect(await service.verify("+911234567890", otp)).toBe(false);
  });

  it("rejects a wrong otp", async () => {
    const service = new OtpService(new InMemoryOtpStore());
    await service.send("+911234567890");

    expect(await service.verify("+911234567890", "000000")).toBe(false);
  });

  it("rejects verify with no otp ever sent", async () => {
    const service = new OtpService(new InMemoryOtpStore());

    expect(await service.verify("+911234567890", "123456")).toBe(false);
  });

  it("keeps otps for different identifiers independent", async () => {
    const service = new OtpService(new InMemoryOtpStore());
    const { otp: otpA } = await service.send("user-a@example.com");
    await service.send("user-b@example.com");

    expect(await service.verify("user-b@example.com", otpA)).toBe(false);
  });
});
