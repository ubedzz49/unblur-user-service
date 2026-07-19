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
});
