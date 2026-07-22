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
  // atomic running-average update, not read-then-write -- returns the new avgRating/ratingCount,
  // null if user doesn't exist
  recordRating(userId: string, rating: number): Promise<{ avgRating: number; ratingCount: number } | null>;
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

  async recordRating(userId: string, rating: number): Promise<{ avgRating: number; ratingCount: number } | null> {
    const existing = this.statsByUserId.get(userId);
    if (!existing) return null;
    // running average -- new_avg = (old_avg * old_count + rating) / (old_count + 1)
    const newCount = existing.ratingCount + 1;
    const newAvg = (existing.avgRating * existing.ratingCount + rating) / newCount;
    const updated = { ...existing, avgRating: newAvg, ratingCount: newCount, updatedAt: new Date().toISOString() };
    this.statsByUserId.set(userId, updated);
    return { avgRating: updated.avgRating, ratingCount: updated.ratingCount };
  }

  // test helper -- no production write path sets minutesListener yet (that lands with whatever
  // service tracks GD/listening attendance), but eligibility tests still need to seed it
  seedMinutesListener(userId: string, minutes: number): void {
    const existing = this.statsByUserId.get(userId);
    if (!existing) return;
    this.statsByUserId.set(userId, { ...existing, minutesListener: minutes });
  }
}
