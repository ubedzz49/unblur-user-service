-- Adds password-based login alongside OTP. password_hash already exists on the users table
-- (see 001_create_users.sql) but has never been populated -- every existing user is OTP-only
-- so far. must_reset_password flags accounts that are currently using a hash we assigned for
-- them (the shared default below) rather than one they chose themselves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every row that exists at the moment this migration runs gets a bcrypt hash of the
-- literal default password "ubed5573" (cost factor 12) and is flagged must_reset_password = true,
-- forcing a password change via POST /users/me/password before they can rely on password login.
-- Rows inserted after this migration runs are untouched by this UPDATE (WHERE password_hash IS
-- NULL only matches the pre-existing, never-set-a-password rows at migration time) and keep
-- password_hash = NULL / must_reset_password = false, i.e. OTP-only until they set their own
-- password explicitly.
UPDATE users
SET password_hash = '$2b$12$8JaH97YE6nBQGBQlVZW9Kuxx8e2E6VJNsCez7VDxnrHz7gQrPHnbS',
    must_reset_password = true
WHERE password_hash IS NULL;
