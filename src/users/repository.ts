import { randomUUID } from "node:crypto";

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

export interface FindOrCreateResult {
  user: User;
  isNew: boolean;
}

export interface UserPasswordInfo {
  id: string;
  passwordHash: string | null;
  mustResetPassword: boolean;
}

export interface UserRepository {
  findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<FindOrCreateResult>;
  findById(id: string): Promise<User | null>;
  updateProfile(id: string, update: ProfileUpdate): Promise<User | null>;
  // identifier is email or phone, same lookup semantics as findOrCreateByIdentifier but
  // read-only and includes the password fields needed for POST /auth/password/login
  findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null>;
  // needed by POST /users/me/password to check the caller's current password before changing it
  findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null>;
  setPassword(userId: string, passwordHash: string, mustResetPassword: boolean): Promise<void>;
}

// test-only -- avoids CI needing a real Postgres instance
export class InMemoryUserRepository implements UserRepository {
  private usersById = new Map<string, User>();
  private idsByIdentifier = new Map<string, string>();
  private passwordsById = new Map<string, { passwordHash: string | null; mustResetPassword: boolean }>();

  async findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<FindOrCreateResult> {
    const existingId = this.idsByIdentifier.get(identifier);
    if (existingId) return { user: this.usersById.get(existingId)!, isNew: false };

    // real uuid, not a placeholder string -- some endpoints (GET /users/:id/public) validate
    // the id looks like a real uuid before querying, so tests need a realistic shape here too
    const id = randomUUID();
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
    this.passwordsById.set(id, { passwordHash: null, mustResetPassword: false });
    return { user, isNew: true };
  }

  async findById(id: string): Promise<User | null> {
    return this.usersById.get(id) ?? null;
  }

  async findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null> {
    const id = this.idsByIdentifier.get(identifier);
    if (!id) return null;
    const pw = this.passwordsById.get(id) ?? { passwordHash: null, mustResetPassword: false };
    return { id, passwordHash: pw.passwordHash, mustResetPassword: pw.mustResetPassword };
  }

  async findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null> {
    if (!this.usersById.has(userId)) return null;
    const pw = this.passwordsById.get(userId) ?? { passwordHash: null, mustResetPassword: false };
    return { id: userId, passwordHash: pw.passwordHash, mustResetPassword: pw.mustResetPassword };
  }

  async setPassword(userId: string, passwordHash: string, mustResetPassword: boolean): Promise<void> {
    this.passwordsById.set(userId, { passwordHash, mustResetPassword });
  }

  // test helper -- seeds a user with a pre-set password hash to simulate the backfilled
  // default-password state without going through /users/me/password
  seedPassword(userId: string, passwordHash: string | null, mustResetPassword: boolean): void {
    this.passwordsById.set(userId, { passwordHash, mustResetPassword });
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
