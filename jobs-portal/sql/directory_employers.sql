-- Companies directory overlay for Sponsorship Hub registers (UK Home Office + Ireland DETE).
-- Does not insert register rows into ATS `companies` (owned by CAFY-JOBS).
-- Run in the Supabase SQL editor. ProductBackend falls back if the table/RPCs are missing.

CREATE TABLE IF NOT EXISTS public.directory_employers (
  id bigint PRIMARY KEY,
  catalog text NOT NULL CHECK (catalog IN ('uk', 'ireland')),
  source text NOT NULL CHECK (source IN ('uk_home_office', 'ie_dete', 'jobs_catalog')),
  -- Soft link only: companies.id is text and some ATS ids are missing/orphaned.
  company_id text,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  legal_name text,
  location_city text,
  type_rating text,
  route text,
  register_volume integer NOT NULL DEFAULT 0,
  job_count integer NOT NULL DEFAULT 0,
  licensed_sponsor boolean NOT NULL DEFAULT false,
  ireland_permit_employer boolean NOT NULL DEFAULT false,
  description text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_employers_catalog_norm
  ON public.directory_employers (catalog, normalized_name);

DO $$
BEGIN
  ALTER TABLE public.directory_employers
    ADD CONSTRAINT directory_employers_catalog_norm_key
    UNIQUE USING INDEX idx_directory_employers_catalog_norm;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_directory_employers_rank
  ON public.directory_employers (catalog, job_count DESC, register_volume DESC, display_name ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_employers_catalog_company
  ON public.directory_employers (catalog, company_id)
  WHERE company_id IS NOT NULL;

ALTER TABLE public.directory_employers
  DROP CONSTRAINT IF EXISTS directory_employers_company_id_fkey;

CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON public.jobs (company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_ir_company_id ON public."jobs_IR" (company_id);

ALTER TABLE public.directory_employers ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.directory_employers TO service_role;

DROP FUNCTION IF EXISTS public.list_portal_directory_companies(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.list_portal_directory_companies_count(text, text);

CREATE OR REPLACE FUNCTION public.list_portal_directory_companies(
  p_catalog text DEFAULT 'uk',
  p_search text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  company_id bigint,
  job_count bigint,
  register_volume integer
)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT nullif(btrim(coalesce(p_search, '')), '') AS search_raw
  ),
  live AS (
    SELECT j.company_id::text AS company_id, COUNT(*)::bigint AS job_count
    FROM public.jobs j
    WHERE lower(coalesce(p_catalog, 'uk')) <> 'ireland'
      AND j.company_id IS NOT NULL
    GROUP BY j.company_id::text
    UNION ALL
    SELECT j.company_id::text AS company_id, COUNT(*)::bigint AS job_count
    FROM public."jobs_IR" j
    WHERE lower(coalesce(p_catalog, 'uk')) = 'ireland'
      AND j.company_id IS NOT NULL
    GROUP BY j.company_id::text
  )
  SELECT
    d.id AS company_id,
    COALESCE(l.job_count, d.job_count, 0)::bigint AS job_count,
    d.register_volume
  FROM public.directory_employers d
  LEFT JOIN live l ON l.company_id = COALESCE(d.company_id, d.id::text)
  LEFT JOIN public.companies c ON c.id::text = COALESCE(d.company_id, d.id::text)
  CROSS JOIN q
  WHERE d.catalog = lower(coalesce(p_catalog, 'uk'))
    AND (
      q.search_raw IS NULL
      OR d.display_name ILIKE '%' || q.search_raw || '%'
      OR coalesce(d.legal_name, '') ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.trading_name, '') ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.companies_house_name, '') ILIKE '%' || q.search_raw || '%'
    )
  ORDER BY
    COALESCE(l.job_count, d.job_count, 0) DESC,
    d.register_volume DESC,
    d.display_name ASC NULLS LAST,
    d.id ASC
  OFFSET GREATEST(coalesce(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
$$;

CREATE OR REPLACE FUNCTION public.list_portal_directory_companies_count(
  p_catalog text DEFAULT 'uk',
  p_search text DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT nullif(btrim(coalesce(p_search, '')), '') AS search_raw
  )
  SELECT COUNT(*)::bigint
  FROM public.directory_employers d
  LEFT JOIN public.companies c ON c.id::text = COALESCE(d.company_id, d.id::text)
  CROSS JOIN q
  WHERE d.catalog = lower(coalesce(p_catalog, 'uk'))
    AND (
      q.search_raw IS NULL
      OR d.display_name ILIKE '%' || q.search_raw || '%'
      OR coalesce(d.legal_name, '') ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.trading_name, '') ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.companies_house_name, '') ILIKE '%' || q.search_raw || '%'
    );
$$;

GRANT EXECUTE ON FUNCTION public.list_portal_directory_companies(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_portal_directory_companies_count(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
