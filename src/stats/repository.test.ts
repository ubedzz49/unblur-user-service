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

  it("recordRating computes a running average across multiple ratings", async () => {
    const repo = new InMemoryStatsRepository();
    await repo.initializeForUser("user-1");

    const first = await repo.recordRating("user-1", 5);
    expect(first).toEqual({ avgRating: 5, ratingCount: 1 });

    // (5 + 3) / 2 = 4, exactly
    const second = await repo.recordRating("user-1", 3);
    expect(second).toEqual({ avgRating: 4, ratingCount: 2 });

    // (5 + 3 + 4) / 3 = 4, exactly
    const third = await repo.recordRating("user-1", 4);
    expect(third).toEqual({ avgRating: 4, ratingCount: 3 });
  });

  it("recordRating returns null for a nonexistent user", async () => {
    const repo = new InMemoryStatsRepository();
    expect(await repo.recordRating("nonexistent", 5)).toBeNull();
  });
});
