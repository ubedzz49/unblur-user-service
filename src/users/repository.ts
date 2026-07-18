export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  aiNotesAndTranscriptsEnabled: boolean;
  createdAt: string;
}

export interface UserRepository {
  findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<User>;
  findById(id: string): Promise<User | null>;
}

// test-only -- avoids CI needing a real Postgres instance
export class InMemoryUserRepository implements UserRepository {
  private usersById = new Map<string, User>();
  private idsByIdentifier = new Map<string, string>();
  private nextId = 1;

  async findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<User> {
    const existingId = this.idsByIdentifier.get(identifier);
    if (existingId) return this.usersById.get(existingId)!;

    const id = `test-user-${this.nextId++}`;
    const user: User = {
      id,
      email: isEmail ? identifier : null,
      phone: isEmail ? null : identifier,
      aiNotesAndTranscriptsEnabled: false,
      createdAt: new Date(0).toISOString(),
    };
    this.usersById.set(id, user);
    this.idsByIdentifier.set(identifier, id);
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.usersById.get(id) ?? null;
  }
}
