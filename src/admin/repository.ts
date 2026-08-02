export type AdminRole = "admin" | "superadmin";

export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  createdAt: string;
}

export interface CreateAdminUserInput {
  username: string;
  passwordHash: string;
  role: AdminRole;
}

export interface AdminUsersRepository {
  findByUsername(username: string): Promise<AdminUser | null>;
  findById(id: string): Promise<AdminUser | null>;
  create(input: CreateAdminUserInput): Promise<AdminUser>;
  list(): Promise<AdminUser[]>;
  delete(id: string): Promise<boolean>;
}

// test-only
export class InMemoryAdminUsersRepository implements AdminUsersRepository {
  private users = new Map<string, AdminUser>();
  private nextId = 1;

  async findByUsername(username: string): Promise<AdminUser | null> {
    return Array.from(this.users.values()).find((u) => u.username === username) ?? null;
  }

  async findById(id: string): Promise<AdminUser | null> {
    return this.users.get(id) ?? null;
  }

  async create(input: CreateAdminUserInput): Promise<AdminUser> {
    const admin: AdminUser = { id: `admin-${this.nextId++}`, ...input, createdAt: new Date().toISOString() };
    this.users.set(admin.id, admin);
    return admin;
  }

  async list(): Promise<AdminUser[]> {
    return Array.from(this.users.values());
  }

  async delete(id: string): Promise<boolean> {
    return this.users.delete(id);
  }
}
