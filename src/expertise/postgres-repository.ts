import { Pool } from "pg";
import {
  DuplicateExpertiseError,
  ExpertiseOptionNotFoundError,
  ExpertiseRepository,
  ExpertiseTypeOption,
  UserExpertiseEntry,
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
}
