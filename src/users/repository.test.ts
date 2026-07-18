import { describe, expect, it } from "vitest";
import { InMemoryUserRepository } from "./repository.js";

describe("InMemoryUserRepository", () => {
  it("creates a user on first lookup, returns the same user on subsequent lookups", async () => {
    const repo = new InMemoryUserRepository();

    const first = await repo.findOrCreateByIdentifier("student@example.com", true);
    const second = await repo.findOrCreateByIdentifier("student@example.com", true);

    expect(second.id).toBe(first.id);
    expect(first.email).toBe("student@example.com");
    expect(first.phone).toBeNull();
  });

  it("keeps email and phone identifiers as separate users", async () => {
    const repo = new InMemoryUserRepository();

    const emailUser = await repo.findOrCreateByIdentifier("student@example.com", true);
    const phoneUser = await repo.findOrCreateByIdentifier("+911234567890", false);

    expect(emailUser.id).not.toBe(phoneUser.id);
    expect(phoneUser.phone).toBe("+911234567890");
  });

  it("findById returns null for an unknown id", async () => {
    const repo = new InMemoryUserRepository();
    expect(await repo.findById("nonexistent")).toBeNull();
  });
});
