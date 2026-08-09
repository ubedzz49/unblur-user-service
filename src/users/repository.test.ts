import { describe, expect, it } from "vitest";
import { InMemoryUserRepository } from "./repository.js";

describe("InMemoryUserRepository", () => {
  it("creates a user on first lookup, returns the same user on subsequent lookups", async () => {
    const repo = new InMemoryUserRepository();

    const first = await repo.findOrCreateByIdentifier("student@example.com", true);
    const second = await repo.findOrCreateByIdentifier("student@example.com", true);

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(first.user.email).toBe("student@example.com");
    expect(first.user.phone).toBeNull();
  });

  it("keeps email and phone identifiers as separate users", async () => {
    const repo = new InMemoryUserRepository();

    const emailUser = await repo.findOrCreateByIdentifier("student@example.com", true);
    const phoneUser = await repo.findOrCreateByIdentifier("+911234567890", false);

    expect(emailUser.user.id).not.toBe(phoneUser.user.id);
    expect(phoneUser.user.phone).toBe("+911234567890");
  });

  it("findById returns null for an unknown id", async () => {
    const repo = new InMemoryUserRepository();
    expect(await repo.findById("nonexistent")).toBeNull();
  });

  it("updates only the fields provided, leaves the rest alone", async () => {
    const repo = new InMemoryUserRepository();
    const { user } = await repo.findOrCreateByIdentifier("student@example.com", true);

    const afterFirstUpdate = await repo.updateProfile(user.id, { name: "Asha" });
    expect(afterFirstUpdate?.name).toBe("Asha");
    expect(afterFirstUpdate?.bio).toBeNull();

    const afterSecondUpdate = await repo.updateProfile(user.id, { bio: "Maths tutor" });
    expect(afterSecondUpdate?.name).toBe("Asha");
    expect(afterSecondUpdate?.bio).toBe("Maths tutor");
  });

  it("updateProfile returns null for an unknown user", async () => {
    const repo = new InMemoryUserRepository();
    expect(await repo.updateProfile("nonexistent", { name: "Asha" })).toBeNull();
  });

  it("auto-generates a unique username on creation", async () => {
    const repo = new InMemoryUserRepository();
    const { user } = await repo.findOrCreateByIdentifier("student@example.com", true);
    expect(user.username).toBeTruthy();
    expect(user.username).toMatch(/^student-[0-9a-f]{6}$/);
  });

  it("isUsernameTaken is case-insensitive and excludes the given user", async () => {
    const repo = new InMemoryUserRepository();
    const { user } = await repo.findOrCreateByIdentifier("student@example.com", true);
    await repo.updateProfile(user.id, { username: "asha-tutor" });

    expect(await repo.isUsernameTaken("ASHA-TUTOR")).toBe(true);
    expect(await repo.isUsernameTaken("asha-tutor", user.id)).toBe(false);
    expect(await repo.isUsernameTaken("nobody-has-this")).toBe(false);
  });

  it("searchUsers matches on username or name substring and excludes blocked users", async () => {
    const repo = new InMemoryUserRepository();
    const { user: target } = await repo.findOrCreateByIdentifier("target@example.com", true);
    await repo.updateProfile(target.id, { username: "asha-tutor", name: "Asha" });
    const { user: blocked } = await repo.findOrCreateByIdentifier("blocked@example.com", true);
    await repo.updateProfile(blocked.id, { username: "asha-blocked" });
    await repo.blockByEmail("blocked@example.com");

    const results = await repo.searchUsers("asha", 10);
    expect(results).toEqual([{ id: target.id, username: "asha-tutor", name: "Asha", photoUrl: null }]);
  });
});
