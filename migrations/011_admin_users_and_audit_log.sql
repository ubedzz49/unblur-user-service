-- Version 9 RBAC: real admin accounts (multiple, roled), replacing the single fixed
-- ADMIN_USERNAME/ADMIN_PASSWORD_HASH credential pair. That pair is still read at boot and
-- upserted as the first superadmin row below, so existing access is never lost -- see
-- src/index.ts's seedFixedAdminIfConfigured().
CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'superadmin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- every admin/refund/block/resolve/cancel/notification-send action across every service, in one
-- queryable place -- previously only existed as a structured log line per ARCHITECTURE_DECISIONS.md
CREATE TABLE admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);
