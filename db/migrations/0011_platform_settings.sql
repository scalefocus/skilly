-- Platform-wide settings (key/value). First setting: whether *any* signed-in user may
-- propose skills (open contribution), or only members/admins of the target namespace.
-- Managed by platform admins in the admin panel; all changes are audit-logged. §4.
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default: open contribution (preserves prior behavior — any authenticated user can propose).
INSERT INTO platform_settings (key, value) VALUES ('proposals_open', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
