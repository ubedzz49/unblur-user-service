import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PostgresUserRepository } from "../users/postgres-repository.js";
import { PostgresStatsRepository } from "./postgres-repository.js";

// runs against a real postgres, same as every other migration in this project gets dry-run
// against. Point INTEGRATION_DB_* env vars at a scratch db (see ci.yml's postgres service)
// to run this locally: a postgres:16-alpine container with no other tables in it.
const shouldRun = process.env.INTEGRATION_DB_HOST !== undefined;

describe.runIf(shouldRun)("PostgresStatsRepository (real postgres)", () => {
  let pool: Pool;
  let userRepo: PostgresUserRepository;
  let statsRepo: PostgresStatsRepository;

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
    statsRepo = new PostgresStatsRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("gives a brand-new user a stats row in the same transaction as their creation", async () => {
    const { user, isNew } = await userRepo.findOrCreateByIdentifier(`integration-${Date.now()}@example.com`, true);
    expect(isNew).toBe(true);

    const stats = await statsRepo.findByUserId(user.id);
    expect(stats).toMatchObject({ userId: user.id, minutesResolved: 0 });
  });

  it("two concurrent increments both land -- proves it's an atomic SET x = x + $n, not read-then-write", async () => {
    const { user } = await userRepo.findOrCreateByIdentifier(`integration-concurrent-${Date.now()}@example.com`, true);

    // fire both increments without awaiting one before starting the other, so if the
    // implementation were read-then-write instead of a single atomic UPDATE, one of these
    // would read the pre-increment value and clobber the other's write
    const [a, b] = await Promise.all([
      statsRepo.incrementMinutesResolved(user.id, 10),
      statsRepo.incrementMinutesResolved(user.id, 20),
    ]);

    // whichever increment lands second must see the other's effect already applied --
    // if this were read-then-write, one write could stomp the other and this would be 20 or 10
    expect(Math.max(a ?? 0, b ?? 0)).toBe(30);

    const finalStats = await statsRepo.findByUserId(user.id);
    expect(finalStats?.minutesResolved).toBe(30);
  });

  it("returns null incrementing a nonexistent user", async () => {
    const result = await statsRepo.incrementMinutesResolved("00000000-0000-4000-8000-000000000000", 10);
    expect(result).toBeNull();
  });
});
