export interface ExpertiseLevelOption {
  id: string;
  name: string;
  slug: string;
}

export interface ExpertiseTypeOption {
  id: string;
  type: string;
  name: string;
  slug: string;
  levels: ExpertiseLevelOption[];
}

export interface UserExpertiseEntry {
  id: string;
  expertiseTypeId: string;
  expertiseTypeName: string;
  expertiseLevelId: string;
  expertiseLevelName: string;
}

export class ExpertiseOptionNotFoundError extends Error {}
export class DuplicateExpertiseError extends Error {}

export interface ExpertiseRepository {
  listOptions(): Promise<ExpertiseTypeOption[]>;
  listForUser(userId: string): Promise<UserExpertiseEntry[]>;
  addForUser(userId: string, expertiseTypeId: string, expertiseLevelId: string): Promise<UserExpertiseEntry>;
  removeForUser(userId: string, userExpertiseId: string): Promise<boolean>;
}

// test-only -- avoids CI needing a real Postgres instance
export class InMemoryExpertiseRepository implements ExpertiseRepository {
  private options: ExpertiseTypeOption[] = [
    {
      id: "type-maths",
      type: "academic",
      name: "Maths",
      slug: "maths",
      levels: [
        { id: "level-class-10", name: "NCERT Class 10", slug: "ncert-class-10" },
        { id: "level-class-12", name: "NCERT Class 12", slug: "ncert-class-12" },
      ],
    },
    {
      id: "type-cat",
      type: "competitive",
      name: "CAT",
      slug: "cat",
      levels: [
        { id: "level-quant", name: "Quant", slug: "quant" },
        { id: "level-dilr", name: "DILR", slug: "dilr" },
      ],
    },
  ];

  private entriesByUser = new Map<string, UserExpertiseEntry[]>();
  private nextId = 1;

  async listOptions(): Promise<ExpertiseTypeOption[]> {
    return this.options;
  }

  async listForUser(userId: string): Promise<UserExpertiseEntry[]> {
    return this.entriesByUser.get(userId) ?? [];
  }

  async addForUser(userId: string, expertiseTypeId: string, expertiseLevelId: string): Promise<UserExpertiseEntry> {
    const type = this.options.find((t) => t.id === expertiseTypeId);
    const level = type?.levels.find((l) => l.id === expertiseLevelId);
    if (!type || !level) throw new ExpertiseOptionNotFoundError();

    const existing = this.entriesByUser.get(userId) ?? [];
    if (existing.some((e) => e.expertiseTypeId === expertiseTypeId && e.expertiseLevelId === expertiseLevelId)) {
      throw new DuplicateExpertiseError();
    }

    const entry: UserExpertiseEntry = {
      id: `user-expertise-${this.nextId++}`,
      expertiseTypeId: type.id,
      expertiseTypeName: type.name,
      expertiseLevelId: level.id,
      expertiseLevelName: level.name,
    };
    this.entriesByUser.set(userId, [...existing, entry]);
    return entry;
  }

  async removeForUser(userId: string, userExpertiseId: string): Promise<boolean> {
    const existing = this.entriesByUser.get(userId) ?? [];
    const next = existing.filter((e) => e.id !== userExpertiseId);
    this.entriesByUser.set(userId, next);
    return next.length !== existing.length;
  }
}
