export interface UserStats {
  userId: string;
  minutesResolved: number;
  avgRating: number;
  ratingCount: number;
  minutesListener: number;
  updatedAt: string;
}

export interface StatsRepository {
  // idempotent -- inserts a zero-row for userId if one doesn't already exist. Called right
  // after a new user is created so nobody is ever missing a stats row.
  initializeForUser(userId: string): Promise<void>;
  findByUserId(userId: string): Promise<UserStats | null>;
  // atomic add, not read-then-write -- returns the new total, null if user doesn't exist
  incrementMinutesResolved(userId: string, minutes: number): Promise<number | null>;
}

// test-only -- avoids CI needing a real Postgres instance
export class InMemoryStatsRepository implements StatsRepository {
  private statsByUserId = new Map<string, UserStats>();

  async initializeForUser(userId: string): Promise<void> {
    if (this.statsByUserId.has(userId)) return;
    this.statsByUserId.set(userId, {
      userId,
      minutesResolved: 0,
      avgRating: 0,
      ratingCount: 0,
      minutesListener: 0,
      updatedAt: new Date(0).toISOString(),
    });
  }

  async findByUserId(userId: string): Promise<UserStats | null> {
    return this.statsByUserId.get(userId) ?? null;
  }

  async incrementMinutesResolved(userId: string, minutes: number): Promise<number | null> {
    const existing = this.statsByUserId.get(userId);
    if (!existing) return null;
    const updated = { ...existing, minutesResolved: existing.minutesResolved + minutes, updatedAt: new Date().toISOString() };
    this.statsByUserId.set(userId, updated);
    return updated.minutesResolved;
  }
}
