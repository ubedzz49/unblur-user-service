import { Pool } from "pg";
import { AdminRole, AdminUser, AdminUsersRepository, CreateAdminUserInput } from "./repository.js";

function rowToAdminUser(row: Record<string, unknown>): AdminUser {
  return {
    id: row.id as string,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    role: row.role as AdminRole,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export class PostgresAdminUsersRepository implements AdminUsersRepository {
  constructor(private readonly pool: Pool) {}

  async findByUsername(username: string): Promise<AdminUser | null> {
    const { rows } = await this.pool.query("SELECT * FROM admin_users WHERE username = $1", [username]);
    return rows[0] ? rowToAdminUser(rows[0]) : null;
  }

  async findById(id: string): Promise<AdminUser | null> {
    const { rows } = await this.pool.query("SELECT * FROM admin_users WHERE id = $1", [id]);
    return rows[0] ? rowToAdminUser(rows[0]) : null;
  }

  async create(input: CreateAdminUserInput): Promise<AdminUser> {
    const { rows } = await this.pool.query(
      "INSERT INTO admin_users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING *",
      [input.username, input.passwordHash, input.role],
    );
    return rowToAdminUser(rows[0]);
  }

  async list(): Promise<AdminUser[]> {
    const { rows } = await this.pool.query("SELECT * FROM admin_users ORDER BY created_at ASC");
    return rows.map(rowToAdminUser);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM admin_users WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
