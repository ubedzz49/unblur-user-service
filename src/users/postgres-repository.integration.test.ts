import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PostgresUserRepository } from "./postgres-repository.js";

// runs against a real postgres -- see stats/postgres-repository.integration.test.ts for the
// same convention. This file exists specifically because isUsernameTaken's uuid/text type
// mismatch (Postgres error 42883: "operator does not exist: uuid <> text") only ever showed up
// against a real Postgres -- InMemoryUserRepository has no type system to catch it, so
// PATCH /users/me with a username change 500'd in production while every unit test stayed green.
const shouldRun = process.env.INTEGRATION_DB_HOST !== undefined;

describe.runIf(shouldRun)("PostgresUserRepository (real postgres)", () => {
  let pool: Pool;
  let userRepo: PostgresUserRepository;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.INTEGRATION_DB_HOST,
      port: Number(process.env.INTEGRATION_DB_PORT ?? 5432),
      database: process.env.INTEGRATION_DB_NAME,
      user: process.env.INTEGRATION_DB_USER,
      password: process.env.INTEGRATION_DB_PASSWORD,
    });
    await runMigrations(pool);
    userRepo = new PostgresUserRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("isUsernameTaken with excludeUserId does not throw a uuid/text type error (regression for #42883)", async () => {
    const { user } = await userRepo.findOrCreateByIdentifier(`integration-username-${Date.now()}@example.com`, true);

    // this exact call shape -- excludeUserId present -- is what PATCH /users/me hits on every
    // profile save that includes a username, even an unchanged one
    await expect(userRepo.isUsernameTaken(user.username, user.id)).resolves.toBe(false);
  });

  it("isUsernameTaken with no excludeUserId also does not throw (the OTP/signup-time check path)", async () => {
    const { user } = await userRepo.findOrCreateByIdentifier(`integration-username-2-${Date.now()}@example.com`, true);
    await expect(userRepo.isUsernameTaken(user.username)).resolves.toBe(true);
    await expect(userRepo.isUsernameTaken(`definitely-not-taken-${Date.now()}`)).resolves.toBe(false);
  });

  it("updateProfile can change a user's own username end to end (the real PATCH /users/me path)", async () => {
    const { user } = await userRepo.findOrCreateByIdentifier(`integration-username-3-${Date.now()}@example.com`, true);
    const newUsername = `renamed-${Date.now()}`;

    const updated = await userRepo.updateProfile(user.id, { username: newUsername });

    expect(updated?.username).toBe(newUsername);
  });
});
