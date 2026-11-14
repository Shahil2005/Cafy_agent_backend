-- CAFY chat agent: storage for job advert pieces and their meaning vectors (B2 "CAFY Match").
-- Run in the TESTING Supabase project only (SQL Editor). Adds two NEW tables; changes no existing table.
-- Filled by scripts/agent/embedJobs.ts. Piece text is not stored: pieces keep offsets into the job description.
BEGIN;

-- Safety: stop unless this is the testing copy made by scripts/dev (live has `mentors`, not the marker).
DO $cafy$ BEGIN
  IF to_regclass('public.mentors') IS NOT NULL OR to_regclass('public.cafy_testing_replica') IS NULL THEN
    RAISE EXCEPTION 'STOP: this is not the testing database. Nothing was changed.';
  END IF;
END $cafy$;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- One row per piece. source: uk = jobs, ie = "jobs_IR", pt = "part_time_jobs_UK".
CREATE TABLE IF NOT EXISTS public.agent_job_pieces (
  source     text        NOT NULL CHECK (source IN ('uk', 'ie', 'pt')),
  job_id     bigint      NOT NULL,
  piece_no   smallint    NOT NULL,
  section    text        NOT NULL CHECK (section IN ('title', 'duties', 'requirements', 'company', 'benefits', 'other')),
  start_at   integer     NOT NULL,
  end_at     integer     NOT NULL,
  embedding  halfvec(384) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_id, piece_no)
);

-- One row per job: which advert version was embedded, so only changed adverts are redone.
CREATE TABLE IF NOT EXISTS public.agent_job_embed_state (
  source       text        NOT NULL CHECK (source IN ('uk', 'ie', 'pt')),
  job_id       bigint      NOT NULL,
  content_hash text        NOT NULL,
  pieces       smallint    NOT NULL,
  embedded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_id)
);

-- Server-only tables (service role bypasses RLS); no client access.
ALTER TABLE public.agent_job_pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_job_embed_state ENABLE ROW LEVEL SECURITY;

COMMIT;
