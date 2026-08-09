import { Pool } from "pg";
import {
  FindOrCreateResult,
  ProfileUpdate,
  User,
  UserPasswordInfo,
  UserRepository,
  UserSearchResult,
  generateDefaultUsername,
} from "./repository.js";

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photo_url: string | null;
  bio: string | null;
  ai_notes_and_transcripts_enabled: boolean;
  blocked_at: string | null;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    phone: row.phone,
    name: row.name,
    photoUrl: row.photo_url,
    bio: row.bio,
    aiNotesAndTranscriptsEnabled: row.ai_notes_and_transcripts_enabled,
    blockedAt: row.blocked_at,
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
      // generate-and-retry rather than a single guess: collisions are rare (6 random hex bytes)
      // but the unique index means we must handle one anyway, not just hope it never happens
      let username = generateDefaultUsername(identifier);
      for (let attempt = 0; attempt < 5; attempt++) {
        const taken = await client.query("SELECT 1 FROM users WHERE lower(username) = lower($1)", [username]);
        if (taken.rows.length === 0) break;
        username = generateDefaultUsername(identifier);
      }

      // ON CONFLICT DO NOTHING -- two concurrent first-time logins for the same identifier
      // can both reach here past the SELECT above; only one insert should win
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (${column}, username) VALUES ($1, $2) ON CONFLICT (${column}) DO NOTHING RETURNING *`,
        [identifier, username],
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
         username = COALESCE($6, username),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        update.name ?? null,
        update.photoUrl ?? null,
        update.bio ?? null,
        update.aiNotesAndTranscriptsEnabled ?? null,
        update.username ?? null,
      ],
    );
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }

  async isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM users WHERE lower(username) = lower($1) AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000')",
      [username, excludeUserId ?? null],
    );
    return result.rows.length > 0;
  }

  async searchUsers(query: string, limit: number): Promise<UserSearchResult[]> {
    const result = await this.pool.query<{ id: string; username: string; name: string | null; photo_url: string | null }>(
      `SELECT id, username, name, photo_url FROM users
       WHERE blocked_at IS NULL AND (username ILIKE $1 OR name ILIKE $1)
       ORDER BY username ASC
       LIMIT $2`,
      [`%${query}%`, limit],
    );
    return result.rows.map((r) => ({ id: r.id, username: r.username, name: r.name, photoUrl: r.photo_url }));
  }

  async findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null> {
    // tries username first (case-insensitive), then falls back to email/phone -- lets a user log
    // in with any of the three without the caller needing to know which kind of identifier it is
    const byUsername = await this.pool.query<{
      id: string;
      password_hash: string | null;
      must_reset_password: boolean;
      blocked_at: string | null;
    }>("SELECT id, password_hash, must_reset_password, blocked_at FROM users WHERE lower(username) = lower($1)", [
      identifier,
    ]);
    if (byUsername.rows.length > 0) {
      const row = byUsername.rows[0];
      return {
        id: row.id,
        passwordHash: row.password_hash,
        mustResetPassword: row.must_reset_password,
        blockedAt: row.blocked_at,
      };
    }

    const isEmail = identifier.includes("@");
    const column = isEmail ? "email" : "phone";
    const result = await this.pool.query<{
      id: string;
      password_hash: string | null;
      must_reset_password: boolean;
      blocked_at: string | null;
    }>(`SELECT id, password_hash, must_reset_password, blocked_at FROM users WHERE ${column} = $1`, [identifier]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      passwordHash: row.password_hash,
      mustResetPassword: row.must_reset_password,
      blockedAt: row.blocked_at,
    };
  }

  async findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null> {
    const result = await this.pool.query<{
      id: string;
      password_hash: string | null;
      must_reset_password: boolean;
      blocked_at: string | null;
    }>("SELECT id, password_hash, must_reset_password, blocked_at FROM users WHERE id = $1", [userId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      passwordHash: row.password_hash,
      mustResetPassword: row.must_reset_password,
      blockedAt: row.blocked_at,
    };
  }

  async setPassword(userId: string, passwordHash: string, mustResetPassword: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE users SET password_hash = $2, must_reset_password = $3, updated_at = now() WHERE id = $1",
      [userId, passwordHash, mustResetPassword],
    );
  }

  async listUsers(limit: number, offset: number): Promise<User[]> {
    const result = await this.pool.query<UserRow>(
      "SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return result.rows.map(toUser);
  }

  async blockByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      "UPDATE users SET blocked_at = now(), updated_at = now() WHERE email = $1 RETURNING *",
      [email],
    );
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }

  async unblockByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      "UPDATE users SET blocked_at = NULL, updated_at = now() WHERE email = $1 RETURNING *",
      [email],
    );
    return result.rows.length > 0 ? toUser(result.rows[0]) : null;
  }
}
