-- Unique, human-typeable usernames for every end user, so nothing in the product ever needs a
-- raw user-id UUID typed by hand (see the "searchable dropdown" request that motivated this --
-- the frontend now looks users up by username via GET /users/search instead of asking an admin
-- or a GD organizer to know someone's UUID). Login continues to also accept email/phone
-- (POST /auth/password/login tries username first, then falls back to email/phone), so nobody
-- who already logs in with an email loses that ability.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

-- Backfill every pre-existing row with a generated, guaranteed-unique username derived from
-- their name (or the local part of their email/phone if no name is set yet), lowercased and
-- slugified, with a short random suffix to break collisions -- same slugification convention as
-- 002/003/004's expertise seeds and src/expertise/repository.ts's slugify().
UPDATE users
SET username = lower(
  regexp_replace(
    COALESCE(NULLIF(name, ''), split_part(COALESCE(email, phone, 'user'), '@', 1)),
    '[^a-zA-Z0-9]+', '-', 'g'
  )
) || '-' || substr(md5(id::text), 1, 6)
WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- case-insensitive + prefix lookups (GET /users/search) both want this
CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users (lower(username));
