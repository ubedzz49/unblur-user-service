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
});
