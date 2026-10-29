-- 0105: Import a whole repository (SKILLY_SPEC.md §64).
--
--   proposal_imports      one row per repository import: who submitted it, into which namespace,
--                         from which normalized origin at which ref (and the commit the latest
--                         submit pinned), the scan's folder, the mode (review | direct) and the item
--                         totals across submits (*Fix and resubmit* continues the same import).
--                         Written by the import's first submit, updated by later submits of it.
--   proposals.import_id   the import a proposal came from — display and notification only; set at
--                         creation, never changed. Housekeeping deletes of a proposal leave the row.
--
-- The wizard's state is never stored (§64.1 decision 15). No backfill.
BEGIN;

CREATE TABLE IF NOT EXISTS proposal_imports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  target_namespace_id UUID NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  origin_url          TEXT NOT NULL,
  ref                 TEXT NOT NULL,
  commit              TEXT,
  folder              TEXT,
  mode                TEXT NOT NULL
                      CONSTRAINT proposal_imports_mode_check CHECK (mode IN ('review', 'direct')),
  items_submitted     INTEGER NOT NULL DEFAULT 0,
  items_created       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES proposal_imports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_import ON proposals (import_id) WHERE import_id IS NOT NULL;

COMMIT;
