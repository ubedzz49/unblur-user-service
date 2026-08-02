export interface AuditLogEntry {
  id: string;
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateAuditLogEntryInput {
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogRepository {
  create(input: CreateAuditLogEntryInput): Promise<AuditLogEntry>;
  list(limit: number): Promise<AuditLogEntry[]>;
}

// test-only
export class InMemoryAuditLogRepository implements AuditLogRepository {
  private entries: AuditLogEntry[] = [];
  private nextId = 1;

  async create(input: CreateAuditLogEntryInput): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: `audit-${this.nextId++}`,
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.entries.unshift(entry);
    return entry;
  }

  async list(limit: number): Promise<AuditLogEntry[]> {
    return this.entries.slice(0, limit);
  }
}
