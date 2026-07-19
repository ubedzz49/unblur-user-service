import { Pool } from "pg";
import { FindOrCreateResult, ProfileUpdate, User, UserPasswordInfo, UserRepository } from "./repository.js";

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photo_url: string | null;
  bio: string | null;
  ai_notes_and_transcripts_enabled: boolean;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    name: row.name,
    photoUrl: row.photo_url,
    bio: row.bio,
    aiNotesAndTranscriptsEnabled: row.ai_notes_and_transcripts_enabled,
    createdAt: row.created_at,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private pool: Pool) {}

  async findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<FindOrCreateResult> {
    const column = isEmail ? "email" : "phone";

    const existing = await this.pool.query<UserRow>(`SELECT * FROM users WHERE ${column} = $1`, [identifier]);
    if (existing.rows.length > 0) return { user: toUser(existing.rows[0]), isNew: false };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // ON CONFLICT DO NOTHING -- two concurrent first-time logins for the same identifier
      // can both reach here past the SELECT above; only one insert should win
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (${column}) VALUES ($1) ON CONFLICT (${column}) DO NOTHING RETURNING *`,
        [identifier],
      );
      if (inserted.rows.length > 0) {
        // every user needs a stats row from day one -- same transaction so we never end up
        // with a user that has no stats row
        await client.query("INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
          inserted.rows[0].id,
        ]);
        await client.query("COMMIT");
        return { user: toUser(inserted.rows[0]), isNew: true };
      }

      // lost the race -- the other request's insert won, fetch what it created
      const afterConflict = await client.query<UserRow>(`SELECT * FROM users WHERE ${column} = $1`, [identifier]);
      await client.query("COMMIT");
      return { user: toUser(afterConflict.rows[0]), isNew: false };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }

  async updateProfile(id: string, update: ProfileUpdate): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `UPDATE users SET
         name = COALESCE($2, name),
         photo_url = COALESCE($3, photo_url),
         bio = COALESCE($4, bio),
         ai_notes_and_transcripts_enabled = COALESCE($5, ai_notes_and_transcripts_enabled),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, update.name ?? null, update.photoUrl ?? null, update.bio ?? null, update.aiNotesAndTranscriptsEnabled ?? null],
    );
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }

  async findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null> {
    const isEmail = identifier.includes("@");
    const column = isEmail ? "email" : "phone";
    const result = await this.pool.query<{ id: string; password_hash: string | null; must_reset_password: boolean }>(
      `SELECT id, password_hash, must_reset_password FROM users WHERE ${column} = $1`,
      [identifier],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { id: row.id, passwordHash: row.password_hash, mustResetPassword: row.must_reset_password };
  }

  async findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null> {
    const result = await this.pool.query<{ id: string; password_hash: string | null; must_reset_password: boolean }>(
      "SELECT id, password_hash, must_reset_password FROM users WHERE id = $1",
      [userId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { id: row.id, passwordHash: row.password_hash, mustResetPassword: row.must_reset_password };
  }

  async setPassword(userId: string, passwordHash: string, mustResetPassword: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE users SET password_hash = $2, must_reset_password = $3, updated_at = now() WHERE id = $1",
      [userId, passwordHash, mustResetPassword],
    );
  }
}
