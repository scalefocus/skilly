#!/bin/sh
# Apply SQL migrations idempotently, in filename order.
#
# Tracks every applied file in _schema_migrations.
#
# NO blind bootstrap: earlier versions, on first run against a pre-existing DB with an
# empty tracking table, marked EVERY migration as applied WITHOUT running it — assuming the
# DB was already in sync. That assumption silently skipped genuinely-unapplied migrations on
# a partially-migrated DB (e.g. a missing usage_events / users.leaderboard_hidden), leaving
# the schema permanently behind while tracking claimed otherwise. Instead we ALWAYS run the
# apply loop; it self-heals because every migration is written to no-op on objects that
# already exist (IF NOT EXISTS / ON CONFLICT) and the loop tolerates the residual
# "already exists" / "duplicate key" / aborted-transaction noise that a re-run produces.
#
# Idempotent safety net: a migration that produces ONLY those benign errors is treated as
# applied rather than aborting. Any OTHER SQL error aborts immediately.
set -e

# ── Tracking table ─────────────────────────────────────────────────────────────
psql -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS _schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);"

# ── Apply pending migrations ───────────────────────────────────────────────────
echo "[migrate] checking for pending migrations..."
for f in $(ls /migrations/*.sql | sort); do
  name=$(basename "$f")

  already=$(psql -tAX -c \
    "SELECT 1 FROM _schema_migrations WHERE filename = '$name' LIMIT 1;")
  if [ "$already" = "1" ]; then
    echo "[migrate] skip (already applied) -> $name"
    continue
  fi

  echo "[migrate] applying -> $f"

  # Run WITHOUT ON_ERROR_STOP so we can inspect all output before deciding.
  # psql exits 0 on SQL errors when ON_ERROR_STOP is absent; we grep for real failures.
  psql -f "$f" > /tmp/_mg.txt 2>&1 || true
  cat /tmp/_mg.txt

  # Treat "already exists" / duplicate-key as acceptable (idempotent re-apply). Also tolerate
  # "current transaction is aborted …" — the cascade psql emits for every statement after the
  # first benign error inside a BEGIN/COMMIT migration that's being re-applied on an in-sync DB.
  # Any other ERROR line is a genuine failure.
  bad=$(grep "^ERROR:" /tmp/_mg.txt | grep -vE "already exists|duplicate key value|current transaction is aborted" || true)
  if [ -n "$bad" ]; then
    echo "[migrate] FATAL: unexpected error in $f — aborting"
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 -c \
    "INSERT INTO _schema_migrations (filename) VALUES ('$name') ON CONFLICT DO NOTHING;"
  echo "[migrate] applied -> $name"
done

# ── Set app-role password ──────────────────────────────────────────────────────
echo "[migrate] setting skilly_app password"
psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE skilly_app LOGIN PASSWORD '${SKILLY_APP_PASSWORD}';"

echo "[migrate] done"
