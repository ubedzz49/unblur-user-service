import { Pool } from "pg";
import {
  CustomExpertiseResult,
  DuplicateExpertiseError,
  ExpertiseOptionNotFoundError,
  ExpertiseRepository,
  ExpertiseTypeOption,
  GENERAL_LEVEL_NAME,
  GENERAL_LEVEL_SLUG,
  USER_SUBMITTED_TYPE,
  UserExpertiseEntry,
  slugify,
} from "./repository.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

export class PostgresExpertiseRepository implements ExpertiseRepository {
  constructor(private pool: Pool) {}

  async listOptions(): Promise<ExpertiseTypeOption[]> {
    const types = await this.pool.query<{ id: string; type: string; name: string; slug: string }>(
      "SELECT id, type, name, slug FROM expertise_types ORDER BY name",
    );
    const levels = await this.pool.query<{ id: string; expertise_type_id: string; name: string; slug: string }>(
      "SELECT id, expertise_type_id, name, slug FROM expertise_levels ORDER BY name",
    );

    return types.rows.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      slug: t.slug,
      levels: levels.rows
        .filter((l) => l.expertise_type_id === t.id)
        .map((l) => ({ id: l.id, name: l.name, slug: l.slug })),
    }));
  }

  async listForUser(userId: string): Promise<UserExpertiseEntry[]> {
    const result = await this.pool.query<{
      id: string;
      expertise_type_id: string;
      expertise_type_name: string;
      expertise_level_id: string;
      expertise_level_name: string;
    }>(
      `SELECT ue.id, et.id AS expertise_type_id, et.name AS expertise_type_name,
              el.id AS expertise_level_id, el.name AS expertise_level_name
       FROM user_expertise ue
       JOIN expertise_types et ON et.id = ue.expertise_type_id
       JOIN expertise_levels el ON el.id = ue.expertise_level_id
       WHERE ue.user_id = $1
       ORDER BY ue.created_at`,
      [userId],
    );

    return result.rows.map((r) => ({
      id: r.id,
      expertiseTypeId: r.expertise_type_id,
      expertiseTypeName: r.expertise_type_name,
      expertiseLevelId: r.expertise_level_id,
      expertiseLevelName: r.expertise_level_name,
    }));
  }

  async addForUser(userId: string, expertiseTypeId: string, expertiseLevelId: string): Promise<UserExpertiseEntry> {
    try {
      const result = await this.pool.query<{
        id: string;
        expertise_type_name: string;
        expertise_level_name: string;
      }>(
        `INSERT INTO user_expertise (user_id, expertise_type_id, expertise_level_id)
         VALUES ($1, $2, $3)
         RETURNING id,
           (SELECT name FROM expertise_types WHERE id = $2) AS expertise_type_name,
           (SELECT name FROM expertise_levels WHERE id = $3) AS expertise_level_name`,
        [userId, expertiseTypeId, expertiseLevelId],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        expertiseTypeId,
        expertiseTypeName: row.expertise_type_name,
        expertiseLevelId,
        expertiseLevelName: row.expertise_level_name,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION) throw new DuplicateExpertiseError();
      if (code === FOREIGN_KEY_VIOLATION) throw new ExpertiseOptionNotFoundError();
      throw err;
    }
  }

  async removeForUser(userId: string, userExpertiseId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM user_expertise WHERE id = $1 AND user_id = $2", [
      userExpertiseId,
      userId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async findOrCreateCustom(subjectName: string, levelName?: string): Promise<CustomExpertiseResult> {
    const trimmedSubject = subjectName.trim();
    const subjectSlug = slugify(trimmedSubject);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // expertise_types.slug is globally UNIQUE across every category, not just
      // user-submitted -- e.g. migration 003 already seeded academic "Data Structures and
      // Algorithms" under slug 'dsa'. A user typing "DSA" must not attach to or clobber that
      // unrelated curated row. Resolve a canonical slug to use for this subject first: if the
      // "natural" slug is already taken by some other (non-user-submitted) category, fall back
      // to a deterministic suffixed variant. This resolution only depends on stable, pre-existing
      // curated rows, so it produces the *same* canonical slug every time this subject is
      // looked up -- which is what makes find-then-create idempotent across calls.
      let canonicalSlug = subjectSlug;
      for (let suffix = 1; ; suffix++) {
        const collision = await client.query(
          `SELECT 1 FROM expertise_types WHERE lower(slug) = lower($1) AND type != $2`,
          [canonicalSlug, USER_SUBMITTED_TYPE],
        );
        if (collision.rowCount === 0) break;
        canonicalSlug = `${subjectSlug}-user-submitted${suffix > 1 ? `-${suffix}` : ""}`;
      }

      let typeRow = (
        await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM expertise_types WHERE type = $1 AND lower(slug) = lower($2)`,
          [USER_SUBMITTED_TYPE, canonicalSlug],
        )
      ).rows[0];

      if (!typeRow) {
        typeRow = (
          await client.query<{ id: string; name: string }>(
            `INSERT INTO expertise_types (type, name, slug) VALUES ($1, $2, $3)
             ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
             RETURNING id, name`,
            [USER_SUBMITTED_TYPE, trimmedSubject, canonicalSlug],
          )
        ).rows[0];
      }

      const trimmedLevel = levelName?.trim();
      const levelSlug = trimmedLevel ? slugify(trimmedLevel) : GENERAL_LEVEL_SLUG;
      const levelName_ = trimmedLevel || GENERAL_LEVEL_NAME;

      let levelRow = (
        await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM expertise_levels WHERE expertise_type_id = $1 AND lower(slug) = lower($2)`,
          [typeRow.id, levelSlug],
        )
      ).rows[0];

      if (!levelRow) {
        levelRow = (
          await client.query<{ id: string; name: string }>(
            `INSERT INTO expertise_levels (expertise_type_id, name, slug) VALUES ($1, $2, $3)
             ON CONFLICT (expertise_type_id, slug) DO UPDATE SET slug = EXCLUDED.slug
             RETURNING id, name`,
            [typeRow.id, levelName_, levelSlug],
          )
        ).rows[0];
      }

      await client.query("COMMIT");

      return {
        expertiseTypeId: typeRow.id,
        expertiseLevelId: levelRow.id,
        typeName: typeRow.name,
        levelName: levelRow.name,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
