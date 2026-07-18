export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photoUrl: string | null;
  bio: string | null;
  aiNotesAndTranscriptsEnabled: boolean;
  createdAt: string;
}

export interface ProfileUpdate {
  name?: string;
  photoUrl?: string;
  bio?: string;
  aiNotesAndTranscriptsEnabled?: boolean;
}

export interface UserRepository {
  findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<User>;
  findById(id: string): Promise<User | null>;
  updateProfile(id: string, update: ProfileUpdate): Promise<User | null>;
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
      name: null,
      photoUrl: null,
      bio: null,
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

  async updateProfile(id: string, update: ProfileUpdate): Promise<User | null> {
    const user = this.usersById.get(id);
    if (!user) return null;

    const updated: User = {
      ...user,
      name: update.name ?? user.name,
      photoUrl: update.photoUrl ?? user.photoUrl,
      bio: update.bio ?? user.bio,
      aiNotesAndTranscriptsEnabled: update.aiNotesAndTranscriptsEnabled ?? user.aiNotesAndTranscriptsEnabled,
    };
    this.usersById.set(id, updated);
    return updated;
  }
}
