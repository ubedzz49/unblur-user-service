import bcrypt from "bcrypt";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { InMemoryUserRepository } from "./repository.js";
import { verifyAuthToken } from "../jwt.js";

const BCRYPT_COST_FACTOR = 12;

describe("password login and password management", () => {
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

  it("logs in with the correct password and returns a valid jwt with mustResetPassword", async () => {
    const userRepo = new InMemoryUserRepository();
    const user = await createUser(userRepo);
    const hash = await bcrypt.hash("correct-horse-battery", BCRYPT_COST_FACTOR);
    userRepo.seedPassword(user.id, hash, true);

    const app = buildApp(undefined, undefined, userRepo);
    const res = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      payload: { identifier: "student@example.com", password: "correct-horse-battery" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mustResetPassword).toBe(true);
    expect(body.token).toBeTypeOf("string");
    expect(verifyAuthToken(body.token).sub).toBe(user.id);
  });

  it("rejects login with the wrong password", async () => {
    const userRepo = new InMemoryUserRepository();
    const user = await createUser(userRepo);
    const hash = await bcrypt.hash("correct-horse-battery", BCRYPT_COST_FACTOR);
    userRepo.seedPassword(user.id, hash, false);

    const app = buildApp(undefined, undefined, userRepo);
    const res = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      payload: { identifier: "student@example.com", password: "wrong-password" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid credentials" });
  });

  it("rejects login for an unknown identifier with the same message", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(undefined, undefined, userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      payload: { identifier: "nobody@example.com", password: "whatever123" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid credentials" });
  });

  it("rejects login for a user who has never set a password, with the same message", async () => {
    const userRepo = new InMemoryUserRepository();
    await createUser(userRepo);

    const app = buildApp(undefined, undefined, userRepo);
    const res = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      payload: { identifier: "student@example.com", password: "whatever123" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid credentials" });
  });

  it("sets a password for the first time without requiring currentPassword", async () => {
    const userRepo = new InMemoryUserRepository();
    const user = await createUser(userRepo);

    const app = buildApp(undefined, undefined, userRepo);
    const { signAuthToken } = await import("../jwt.js");
    const authToken = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { newPassword: "brand-new-pass" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const info = await userRepo.findPasswordInfoById(user.id);
    expect(info?.mustResetPassword).toBe(false);
    expect(await bcrypt.compare("brand-new-pass", info!.passwordHash!)).toBe(true);
  });

  it("requires and validates currentPassword when changing an existing password", async () => {
    const userRepo = new InMemoryUserRepository();
    const user = await createUser(userRepo);
    const hash = await bcrypt.hash("old-default-pass", BCRYPT_COST_FACTOR);
    userRepo.seedPassword(user.id, hash, true);

    const { signAuthToken } = await import("../jwt.js");
    const authToken = signAuthToken(user.id);
    const app = buildApp(undefined, undefined, userRepo);

    const wrongCurrent = await app.inject({
      method: "POST",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { currentPassword: "not-it", newPassword: "brand-new-pass" },
    });
    expect(wrongCurrent.statusCode).toBe(401);
    expect(wrongCurrent.json()).toEqual({ error: "current password is incorrect" });

    const missingCurrent = await app.inject({
      method: "POST",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { newPassword: "brand-new-pass" },
    });
    expect(missingCurrent.statusCode).toBe(401);

    const correctCurrent = await app.inject({
      method: "POST",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { currentPassword: "old-default-pass", newPassword: "brand-new-pass" },
    });
    expect(correctCurrent.statusCode).toBe(200);

    const info = await userRepo.findPasswordInfoById(user.id);
    expect(info?.mustResetPassword).toBe(false);
    expect(await bcrypt.compare("brand-new-pass", info!.passwordHash!)).toBe(true);
  });

  it("rejects a too-short newPassword", async () => {
    const userRepo = new InMemoryUserRepository();
    const user = await createUser(userRepo);
    const { signAuthToken } = await import("../jwt.js");
    const authToken = signAuthToken(user.id);
    const app = buildApp(undefined, undefined, userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/password",
      headers: { authorization: `Bearer ${authToken}` },
      payload: { newPassword: "short1" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("password backfill semantics (repository-level)", () => {
  // This mirrors what migration 006_password_login.sql does against real Postgres (verified
  // separately via a docker dry-run): pre-existing rows get the shared default hash + must_reset
  // true; rows created after do not. InMemoryUserRepository doesn't run SQL migrations, so this
  // test exercises the same contract at the repository level using seedPassword to stand in for
  // the backfill UPDATE, and a fresh findOrCreateByIdentifier call to stand in for a post-
  // migration signup.
  it("a pre-existing row can be backfilled with a working default password and must_reset_password=true, while a freshly created row is untouched", async () => {
    const userRepo = new InMemoryUserRepository();

    // simulates a user row that existed before the migration ran
    const preExisting = await createUserFor(userRepo, "preexisting@example.com");
    const defaultHash = await bcrypt.hash("ubed5573", BCRYPT_COST_FACTOR);
    userRepo.seedPassword(preExisting.id, defaultHash, true);

    // simulates a user created after the migration (repository sets password_hash = null,
    // must_reset_password = false on creation, same as the migration's untouched-row case)
    const freshUser = await createUserFor(userRepo, "freshuser@example.com");

    const preExistingInfo = await userRepo.findPasswordInfoById(preExisting.id);
    expect(preExistingInfo?.mustResetPassword).toBe(true);
    expect(await bcrypt.compare("ubed5573", preExistingInfo!.passwordHash!)).toBe(true);

    const freshInfo = await userRepo.findPasswordInfoById(freshUser.id);
    expect(freshInfo?.passwordHash).toBeNull();
    expect(freshInfo?.mustResetPassword).toBe(false);
  });

  async function createUserFor(userRepo: InMemoryUserRepository, identifier: string) {
    const { user } = await userRepo.findOrCreateByIdentifier(identifier, true);
    return user;
  }
});
