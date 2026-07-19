import { describe, expect, it } from "vitest";
import {
  DuplicateExpertiseError,
  ExpertiseOptionNotFoundError,
  InMemoryExpertiseRepository,
} from "./repository.js";

describe("InMemoryExpertiseRepository", () => {
  it("lists the seeded options with nested levels", async () => {
    const repo = new InMemoryExpertiseRepository();
    const options = await repo.listOptions();

    const maths = options.find((o) => o.slug === "maths");
    expect(maths).toBeDefined();
    expect(maths!.levels.map((l) => l.slug)).toContain("ncert-class-12");
  });

  it("adds an expertise entry for a user and lists it back", async () => {
    const repo = new InMemoryExpertiseRepository();
    const added = await repo.addForUser("user-1", "type-maths", "level-class-12");

    expect(added.expertiseTypeName).toBe("Maths");
    expect(added.expertiseLevelName).toBe("NCERT Class 12");

    const listed = await repo.listForUser("user-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(added.id);
  });

  it("rejects an unknown type or level", async () => {
    const repo = new InMemoryExpertiseRepository();
    await expect(repo.addForUser("user-1", "nonexistent", "level-class-12")).rejects.toBeInstanceOf(
      ExpertiseOptionNotFoundError,
    );
  });

  it("rejects adding the same expertise and level twice", async () => {
    const repo = new InMemoryExpertiseRepository();
    await repo.addForUser("user-1", "type-maths", "level-class-12");

    await expect(repo.addForUser("user-1", "type-maths", "level-class-12")).rejects.toBeInstanceOf(
      DuplicateExpertiseError,
    );
  });

  it("removes an entry, scoped to the owning user", async () => {
    const repo = new InMemoryExpertiseRepository();
    const added = await repo.addForUser("user-1", "type-maths", "level-class-12");

    expect(await repo.removeForUser("user-1", added.id)).toBe(true);
    expect(await repo.listForUser("user-1")).toHaveLength(0);
  });

  it("returns false when removing something that doesn't exist", async () => {
    const repo = new InMemoryExpertiseRepository();
    expect(await repo.removeForUser("user-1", "nonexistent")).toBe(false);
  });

  it("creates a brand-new custom subject and level", async () => {
    const repo = new InMemoryExpertiseRepository();
    const result = await repo.findOrCreateCustom("DSA", "Beginner");

    expect(result.typeName).toBe("DSA");
    expect(result.levelName).toBe("Beginner");
    expect(result.expertiseTypeId).toBeTruthy();
    expect(result.expertiseLevelId).toBeTruthy();

    const options = await repo.listOptions();
    const type = options.find((o) => o.id === result.expertiseTypeId);
    expect(type?.type).toBe("user-submitted");
    expect(type?.slug).toBe("dsa");
  });

  it("reuses an existing custom subject by slug on a second call", async () => {
    const repo = new InMemoryExpertiseRepository();
    const first = await repo.findOrCreateCustom("DSA", "Beginner");
    const second = await repo.findOrCreateCustom("dsa", "beginner");

    expect(second.expertiseTypeId).toBe(first.expertiseTypeId);
    expect(second.expertiseLevelId).toBe(first.expertiseLevelId);
  });

  it("creates and reuses a 'General' level when no levelName is given", async () => {
    const repo = new InMemoryExpertiseRepository();
    const first = await repo.findOrCreateCustom("Underwater Basket Weaving");
    expect(first.levelName).toBe("General");

    const second = await repo.findOrCreateCustom("Underwater Basket Weaving");
    expect(second.expertiseLevelId).toBe(first.expertiseLevelId);
  });
});
