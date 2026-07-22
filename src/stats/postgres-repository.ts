import { Pool } from "pg";
import { StatsRepository, UserStats } from "./repository.js";

interface StatsRow {
  user_id: string;
  minutes_resolved: number;
  avg_rating: string;
  rating_count: number;
  minutes_listener: number;
  updated_at: string;
}

function toStats(row: StatsRow): UserStats {
  return {
    userId: row.user_id,
    minutesResolved: row.minutes_resolved,
    avgRating: Number(row.avg_rating),
    ratingCount: row.rating_count,
    minutesListener: row.minutes_listener,
    updatedAt: row.updated_at,
  };
}

export class PostgresStatsRepository implements StatsRepository {
  constructor(private pool: Pool) {}

  async initializeForUser(userId: string): Promise<void> {
    await this.pool.query("INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  }

  async findByUserId(userId: string): Promise<UserStats | null> {
    const result = await this.pool.query<StatsRow>("SELECT * FROM user_stats WHERE user_id = $1", [userId]);
    return result.rows.length > 0 ? toStats(result.rows[0]) : null;
  }

  async incrementMinutesResolved(userId: string, minutes: number): Promise<number | null> {
    // atomic SET x = x + $n at the db level -- not a read-then-write, so concurrent
    // increments for the same user can't clobber each other
    const result = await this.pool.query<{ minutes_resolved: number }>(
      `UPDATE user_stats
         SET minutes_resolved = minutes_resolved + $2, updated_at = now()
       WHERE user_id = $1
       RETURNING minutes_resolved`,
      [userId, minutes],
    );
    return result.rows.length > 0 ? result.rows[0].minutes_resolved : null;
  }

  async recordRating(userId: string, rating: number): Promise<{ avgRating: number; ratingCount: number } | null> {
    // running average computed entirely inside the UPDATE so concurrent raters can't clobber
    // each other the way a read-then-write in application code would
    const result = await this.pool.query<{ avg_rating: string; rating_count: number }>(
      `UPDATE user_stats
         SET avg_rating = (avg_rating * rating_count + $2) / (rating_count + 1),
             rating_count = rating_count + 1,
             updated_at = now()
       WHERE user_id = $1
       RETURNING avg_rating, rating_count`,
      [userId, rating],
    );
    if (result.rows.length === 0) return null;
    return { avgRating: Number(result.rows[0].avg_rating), ratingCount: result.rows[0].rating_count };
  }
}
