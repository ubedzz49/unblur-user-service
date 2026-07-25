-- Admin dashboard: a blocked user can no longer log in (checked at OTP verify and password
-- login). Blocking is by email only for now (matches the admin dashboard's requirement) --
-- phone-only accounts have no email to target, a known, documented limitation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ NULL;
