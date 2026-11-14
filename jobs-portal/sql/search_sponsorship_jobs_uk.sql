-- Requires CAFY-JOBS-hari/supabase/add_sponsorship_assessments.sql.
-- Ranked search and counts use the same strict view as browse.
CREATE OR REPLACE FUNCTION public.search_sponsorship_jobs_page(
  p_role_query text DEFAULT NULL,
  p_where_query text DEFAULT NULL,
  p_company_ids integer[] DEFAULT NULL,
  p_excluded_ids text[] DEFAULT NULL,
  p_excluded_company_ids integer[] DEFAULT NULL,
  p_company_id integer DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_sectors text[] DEFAULT NULL,
  p_levels text[] DEFAULT NULL,
  p_job_types text[] DEFAULT NULL
)
RETURNS TABLE (job_id bigint)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT
      nullif(btrim(coalesce(p_role_query, '')), '') AS role_raw,
      nullif(btrim(coalesce(p_where_query, '')), '') AS where_raw
  )
  SELECT j.id::bigint AS job_id
  FROM public.sponsorship_jobs j
  CROSS JOIN q
  WHERE (q.role_raw IS NOT NULL OR q.where_raw IS NOT NULL)
    AND (
      q.role_raw IS NULL
      OR j.title ILIKE '%' || q.role_raw || '%'
      OR coalesce(j.department, '') ILIKE '%' || q.role_raw || '%'
    )
    AND (
      q.where_raw IS NULL
      OR coalesce(j.location, '') ILIKE '%' || q.where_raw || '%'
      OR (p_company_ids IS NOT NULL AND j.company_id = ANY (p_company_ids))
    )
    AND (p_excluded_ids IS NULL OR NOT (j.id::text = ANY (p_excluded_ids)))
    AND (p_excluded_company_ids IS NULL OR NOT (j.company_id = ANY (p_excluded_company_ids)))
    AND (p_company_id IS NULL OR j.company_id = p_company_id)
  ORDER BY
    CASE
      WHEN p_sectors IS NOT NULL AND cardinality(p_sectors) > 0
       AND p_levels IS NOT NULL AND cardinality(p_levels) > 0
       AND p_job_types IS NOT NULL AND cardinality(p_job_types) > 0
       AND j.sector = ANY (p_sectors)
       AND j.level = ANY (p_levels)
       AND j.job_type = ANY (p_job_types) THEN 0
      WHEN p_sectors IS NOT NULL AND cardinality(p_sectors) > 0
       AND p_job_types IS NOT NULL AND cardinality(p_job_types) > 0
       AND j.sector = ANY (p_sectors)
       AND j.job_type = ANY (p_job_types) THEN 1
      WHEN p_sectors IS NOT NULL AND cardinality(p_sectors) > 0
       AND p_levels IS NOT NULL AND cardinality(p_levels) > 0
       AND j.sector = ANY (p_sectors)
       AND j.level = ANY (p_levels) THEN 2
      WHEN p_sectors IS NOT NULL AND cardinality(p_sectors) > 0
       AND j.sector = ANY (p_sectors) THEN 3
      WHEN p_levels IS NOT NULL AND cardinality(p_levels) > 0
       AND p_job_types IS NOT NULL AND cardinality(p_job_types) > 0
       AND j.level = ANY (p_levels)
       AND j.job_type = ANY (p_job_types) THEN 4
      WHEN p_levels IS NOT NULL AND cardinality(p_levels) > 0
       AND j.level = ANY (p_levels) THEN 5
      WHEN p_job_types IS NOT NULL AND cardinality(p_job_types) > 0
       AND j.job_type = ANY (p_job_types) THEN 6
      ELSE 7
    END,
    j.created_at DESC,
    j.id DESC
  OFFSET GREATEST(coalesce(p_offset, 0), 0)
  LIMIT GREATEST(LEAST(coalesce(p_limit, 20), 50), 1);
$$;

CREATE OR REPLACE FUNCTION public.search_sponsorship_jobs_count(
  p_role_query text DEFAULT NULL,
  p_where_query text DEFAULT NULL,
  p_company_ids integer[] DEFAULT NULL,
  p_excluded_ids text[] DEFAULT NULL,
  p_excluded_company_ids integer[] DEFAULT NULL,
  p_company_id integer DEFAULT NULL,
  p_sectors text[] DEFAULT NULL,
  p_levels text[] DEFAULT NULL,
  p_job_types text[] DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT
      nullif(btrim(coalesce(p_role_query, '')), '') AS role_raw,
      nullif(btrim(coalesce(p_where_query, '')), '') AS where_raw
  )
  SELECT count(*)::bigint
  FROM public.sponsorship_jobs j
  CROSS JOIN q
  WHERE (q.role_raw IS NOT NULL OR q.where_raw IS NOT NULL)
    AND (
      q.role_raw IS NULL
      OR j.title ILIKE '%' || q.role_raw || '%'
      OR coalesce(j.department, '') ILIKE '%' || q.role_raw || '%'
    )
    AND (
      q.where_raw IS NULL
      OR coalesce(j.location, '') ILIKE '%' || q.where_raw || '%'
      OR (p_company_ids IS NOT NULL AND j.company_id = ANY (p_company_ids))
    )
    AND (p_excluded_ids IS NULL OR NOT (j.id::text = ANY (p_excluded_ids)))
    AND (p_excluded_company_ids IS NULL OR NOT (j.company_id = ANY (p_excluded_company_ids)))
    AND (p_company_id IS NULL OR j.company_id = p_company_id);
$$;

GRANT EXECUTE ON FUNCTION public.search_sponsorship_jobs_page(
  text, text, integer[], text[], integer[], integer, integer, integer, text[], text[], text[]
) TO service_role;

GRANT EXECUTE ON FUNCTION public.search_sponsorship_jobs_count(
  text, text, integer[], text[], integer[], integer, text[], text[], text[]
) TO service_role;

REVOKE ALL ON FUNCTION public.search_sponsorship_jobs_page(text,text,integer[],text[],integer[],integer,integer,integer,text[],text[],text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_sponsorship_jobs_count(text,text,integer[],text[],integer[],integer,text[],text[],text[]) FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
