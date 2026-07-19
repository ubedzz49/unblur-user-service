-- per-user resolution/listening stats, read by the user themselves and written by
-- Resolution Service via the internal service-to-service endpoint (see 02_architecture.txt 3.1)
CREATE TABLE user_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  minutes_resolved INTEGER NOT NULL DEFAULT 0,
  avg_rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  minutes_listener INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- backfill so every user that existed before this migration has a stats row too --
-- ON CONFLICT DO NOTHING in case this ever gets re-run against a partially-migrated db
INSERT INTO user_stats (user_id)
SELECT id FROM users
ON CONFLICT DO NOTHING;
