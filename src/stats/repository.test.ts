import { describe, expect, it } from "vitest";
import { InMemoryStatsRepository } from "./repository.js";

describe("InMemoryStatsRepository", () => {
  it("initializeForUser is idempotent and starts everything at zero", async () => {
    const repo = new InMemoryStatsRepository();
    await repo.initializeForUser("user-1");
    await repo.initializeForUser("user-1");

    const stats = await repo.findByUserId("user-1");
    expect(stats).toMatchObject({
      userId: "user-1",
      minutesResolved: 0,
      avgRating: 0,
      ratingCount: 0,
      minutesListener: 0,
    });
  });

  it("findByUserId returns null for a user with no row", async () => {
    const repo = new InMemoryStatsRepository();
    expect(await repo.findByUserId("nonexistent")).toBeNull();
  });

  it("incrementMinutesResolved adds to the existing total", async () => {
    const repo = new InMemoryStatsRepository();
    await repo.initializeForUser("user-1");

    const first = await repo.incrementMinutesResolved("user-1", 20);
    expect(first).toBe(20);

    const second = await repo.incrementMinutesResolved("user-1", 10);
    expect(second).toBe(30);
  });

  it("incrementMinutesResolved returns null for a nonexistent user", async () => {
    const repo = new InMemoryStatsRepository();
    expect(await repo.incrementMinutesResolved("nonexistent", 10)).toBeNull();
  });
});
