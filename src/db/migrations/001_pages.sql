-- Migration 001: pages manifest table
--
-- Creates the `pages` table used by the pipeline to track the processing
-- status, content hash, and output path for every OneNote page.  The table
-- is the single source of truth for incremental sync: the pipeline consults
-- it to decide which pages need reprocessing and records outcomes here so
-- that failures are observable and retried on the next run.
--
-- Run via: npm run db:migrate

CREATE TABLE IF NOT EXISTS pages (
  id             text        PRIMARY KEY,
  title          text        NOT NULL,
  section        text        NOT NULL,
  last_modified  timestamptz NOT NULL,
  content_hash   text,
  markdown_path  text,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processed', 'failed')),
  processed_at   timestamptz,
  error_message  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Supports getPagesByStatus() — avoids a full-table scan on every pipeline run.
CREATE INDEX IF NOT EXISTS pages_status_idx        ON pages (status);

-- Supports change-detection queries ordered or filtered by modification time.
CREATE INDEX IF NOT EXISTS pages_last_modified_idx ON pages (last_modified);

-- Trigger function: keeps updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION update_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pages_updated_at ON pages;
CREATE TRIGGER pages_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
