import { randomUUID, randomBytes } from "node:crypto";

export interface User {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photoUrl: string | null;
  bio: string | null;
  aiNotesAndTranscriptsEnabled: boolean;
  blockedAt: string | null;
  createdAt: string;
}

// what a searchable-dropdown typeahead needs and nothing more -- no email/phone, this is shown
// to other end users (e.g. picking a GD vote recipient or an admin picking who to notify), not
// just admins
export interface UserSearchResult {
  id: string;
  username: string;
  name: string | null;
  photoUrl: string | null;
}

export interface ProfileUpdate {
  name?: string;
  photoUrl?: string;
  bio?: string;
  aiNotesAndTranscriptsEnabled?: boolean;
  username?: string;
}

// Matches the slugification convention used by src/expertise/repository.ts's slugify() and the
// 012_usernames.sql backfill: lowercase, non-alphanumeric runs collapsed to a single hyphen, no
// leading/trailing hyphens. A short random suffix breaks collisions on auto-generated usernames
// (chosen ones from PATCH /users/me go through uniqueness-checked repository calls instead).
export function slugifyUsername(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateDefaultUsername(seed: string): string {
  const base = slugifyUsername(seed.split("@")[0]) || "user";
  const suffix = randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

export interface FindOrCreateResult {
  user: User;
  isNew: boolean;
}

export interface UserPasswordInfo {
  id: string;
  passwordHash: string | null;
  mustResetPassword: boolean;
  blockedAt: string | null;
}

export interface UserRepository {
  findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<FindOrCreateResult>;
  findById(id: string): Promise<User | null>;
  updateProfile(id: string, update: ProfileUpdate): Promise<User | null>;
  // identifier can be a username, email, or phone (tried in that order) -- same read-only
  // shape as findOrCreateByIdentifier's password fields, used by POST /auth/password/login
  findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null>;
  // needed by POST /users/me/password to check the caller's current password before changing it
  findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null>;
  setPassword(userId: string, passwordHash: string, mustResetPassword: boolean): Promise<void>;
  // true if some OTHER user already has this username (case-insensitive) -- excludeUserId lets
  // PATCH /users/me re-save a profile without tripping over the caller's own current username
  isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean>;
  // typeahead backing GET /users/search -- matches on username or name, case-insensitive,
  // excludes blocked accounts (nothing should let you pick a blocked user out of a dropdown)
  searchUsers(query: string, limit: number): Promise<UserSearchResult[]>;

  // admin-only
  listUsers(limit: number, offset: number): Promise<User[]>;
  blockByEmail(email: string): Promise<User | null>;
  unblockByEmail(email: string): Promise<User | null>;
}

// test-only -- avoids CI needing a real Postgres instance
export class InMemoryUserRepository implements UserRepository {
  private usersById = new Map<string, User>();
  private idsByIdentifier = new Map<string, string>();
  private idsByUsername = new Map<string, string>(); // keyed lowercase
  private passwordsById = new Map<string, { passwordHash: string | null; mustResetPassword: boolean }>();

  async findOrCreateByIdentifier(identifier: string, isEmail: boolean): Promise<FindOrCreateResult> {
    const existingId = this.idsByIdentifier.get(identifier);
    if (existingId) return { user: this.usersById.get(existingId)!, isNew: false };

    // real uuid, not a placeholder string -- some endpoints (GET /users/:id/public) validate
    // the id looks like a real uuid before querying, so tests need a realistic shape here too
    const id = randomUUID();
    let username = generateDefaultUsername(identifier);
    while (this.idsByUsername.has(username.toLowerCase())) {
      username = generateDefaultUsername(identifier);
    }
    const user: User = {
      id,
      username,
      email: isEmail ? identifier : null,
      phone: isEmail ? null : identifier,
      name: null,
      photoUrl: null,
      bio: null,
      aiNotesAndTranscriptsEnabled: false,
      blockedAt: null,
      createdAt: new Date(0).toISOString(),
    };
    this.usersById.set(id, user);
    this.idsByIdentifier.set(identifier, id);
    this.idsByUsername.set(username.toLowerCase(), id);
    this.passwordsById.set(id, { passwordHash: null, mustResetPassword: false });
    return { user, isNew: true };
  }

  async findById(id: string): Promise<User | null> {
    return this.usersById.get(id) ?? null;
  }

  async findByIdentifierWithPassword(identifier: string): Promise<UserPasswordInfo | null> {
    const id = this.idsByUsername.get(identifier.toLowerCase()) ?? this.idsByIdentifier.get(identifier);
    if (!id) return null;
    const pw = this.passwordsById.get(id) ?? { passwordHash: null, mustResetPassword: false };
    return {
      id,
      passwordHash: pw.passwordHash,
      mustResetPassword: pw.mustResetPassword,
      blockedAt: this.usersById.get(id)?.blockedAt ?? null,
    };
  }

  async isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
    const id = this.idsByUsername.get(username.toLowerCase());
    return id !== undefined && id !== excludeUserId;
  }

  async searchUsers(query: string, limit: number): Promise<UserSearchResult[]> {
    const q = query.toLowerCase();
    return Array.from(this.usersById.values())
      .filter((u) => !u.blockedAt && (u.username.toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q)))
      .slice(0, limit)
      .map((u) => ({ id: u.id, username: u.username, name: u.name, photoUrl: u.photoUrl }));
  }

  async findPasswordInfoById(userId: string): Promise<UserPasswordInfo | null> {
    if (!this.usersById.has(userId)) return null;
    const pw = this.passwordsById.get(userId) ?? { passwordHash: null, mustResetPassword: false };
    return {
      id: userId,
      passwordHash: pw.passwordHash,
      mustResetPassword: pw.mustResetPassword,
      blockedAt: this.usersById.get(userId)?.blockedAt ?? null,
    };
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
      username: update.username ?? user.username,
    };
    if (update.username && update.username.toLowerCase() !== user.username.toLowerCase()) {
      this.idsByUsername.delete(user.username.toLowerCase());
      this.idsByUsername.set(update.username.toLowerCase(), id);
    }
    this.usersById.set(id, updated);
    return updated;
  }

  async listUsers(limit: number, offset: number): Promise<User[]> {
    return Array.from(this.usersById.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(offset, offset + limit);
  }

  async blockByEmail(email: string): Promise<User | null> {
    const id = this.idsByIdentifier.get(email);
    const user = id ? this.usersById.get(id) : undefined;
    if (!user) return null;
    const updated: User = { ...user, blockedAt: new Date().toISOString() };
    this.usersById.set(user.id, updated);
    return updated;
  }

  async unblockByEmail(email: string): Promise<User | null> {
    const id = this.idsByIdentifier.get(email);
    const user = id ? this.usersById.get(id) : undefined;
    if (!user) return null;
    const updated: User = { ...user, blockedAt: null };
    this.usersById.set(user.id, updated);
    return updated;
  }
}
