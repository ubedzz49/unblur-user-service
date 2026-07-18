import { Pool } from "pg";
import { User, UserRepository } from "./repository.js";

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  ai_notes_and_transcripts_enabled: boolean;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    aiNotesAndTranscriptsEnabled: row.ai_notes_and_transcripts_enabled,
    createdAt: row.created_at,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private pool: Pool) {}

  async findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<User> {
    const column = isEmail ? "email" : "phone";

    const existing = await this.pool.query<UserRow>(`SELECT * FROM users WHERE ${column} = $1`, [identifier]);
    if (existing.rows.length > 0) return toUser(existing.rows[0]);

    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO users (${column}) VALUES ($1) RETURNING *`,
      [identifier],
    );
    return toUser(inserted.rows[0]);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }
}
