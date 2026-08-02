import { Pool } from "pg";
import { AuditLogEntry, AuditLogRepository, CreateAuditLogEntryInput } from "./audit-log-repository.js";

function rowToEntry(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    adminUserId: row.admin_user_id as string,
    adminUsername: row.admin_username as string,
    action: row.action as string,
    targetType: row.target_type as string,
    targetId: row.target_id as string,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAuditLogEntryInput): Promise<AuditLogEntry> {
    const { rows } = await this.pool.query(
      `INSERT INTO admin_audit_log (admin_user_id, admin_username, action, target_type, target_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.adminUserId, input.adminUsername, input.action, input.targetType, input.targetId, JSON.stringify(input.metadata ?? {})],
    );
    return rowToEntry(rows[0]);
  }

  async list(limit: number): Promise<AuditLogEntry[]> {
    const { rows } = await this.pool.query("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map(rowToEntry);
  }
}
