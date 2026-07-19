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

export interface CustomExpertiseResult {
  expertiseTypeId: string;
  expertiseLevelId: string;
  typeName: string;
  levelName: string;
}

export const USER_SUBMITTED_TYPE = "user-submitted";
export const GENERAL_LEVEL_NAME = "General";
export const GENERAL_LEVEL_SLUG = "general";

// Matches the slugification convention used by the seed migrations (002/003/004): lowercase,
// non-alphanumeric runs collapsed to a single hyphen, no leading/trailing hyphens.
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ExpertiseRepository {
  listOptions(): Promise<ExpertiseTypeOption[]>;
  listForUser(userId: string): Promise<UserExpertiseEntry[]>;
  addForUser(userId: string, expertiseTypeId: string, expertiseLevelId: string): Promise<UserExpertiseEntry>;
  removeForUser(userId: string, userExpertiseId: string): Promise<boolean>;
  // find-or-create a "user-submitted" taxonomy node for a subject the curated taxonomy doesn't
  // have. Two different users typing the same subject (case-insensitively, once slugified)
  // reuse the same node rather than creating duplicates.
  findOrCreateCustom(subjectName: string, levelName?: string): Promise<CustomExpertiseResult>;
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

  async findOrCreateCustom(subjectName: string, levelName?: string): Promise<CustomExpertiseResult> {
    const trimmedSubject = subjectName.trim();
    const subjectSlug = slugify(trimmedSubject);

    let type = this.options.find((t) => t.type === USER_SUBMITTED_TYPE && t.slug === subjectSlug);
    if (!type) {
      type = {
        id: `type-custom-${this.nextId++}`,
        type: USER_SUBMITTED_TYPE,
        name: trimmedSubject,
        slug: subjectSlug,
        levels: [],
      };
      this.options = [...this.options, type];
    }

    const trimmedLevel = levelName?.trim();
    const levelSlug = trimmedLevel ? slugify(trimmedLevel) : GENERAL_LEVEL_SLUG;
    const resolvedLevelName = trimmedLevel || GENERAL_LEVEL_NAME;

    let level = type.levels.find((l) => l.slug === levelSlug);
    if (!level) {
      level = { id: `level-custom-${this.nextId++}`, name: resolvedLevelName, slug: levelSlug };
      type.levels = [...type.levels, level];
    }

    return {
      expertiseTypeId: type.id,
      expertiseLevelId: level.id,
      typeName: type.name,
      levelName: level.name,
    };
  }
}
