-- Migration 001: pages manifest table
-- Run via: npm run db:migrate

CREATE TABLE IF NOT EXISTS pages (
  id            TEXT        PRIMARY KEY,
  title         TEXT        NOT NULL DEFAULT '',
  section       TEXT        NOT NULL DEFAULT '',
  last_modified TEXT        NOT NULL DEFAULT '',
  content_hash  TEXT,
  markdown_path TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processed', 'failed')),
  processed_at  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index used by getPagesByStatus to avoid a full-table scan.
CREATE INDEX IF NOT EXISTS pages_status_idx   ON pages (status);
-- Index used by discover stage lookups by section.
CREATE INDEX IF NOT EXISTS pages_section_idx  ON pages (section);

-- Keep updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pages_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
