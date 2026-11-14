-- Jobs-only ranked companies (live job_count DESC). Used when COMPANIES_INCLUDE_REGISTER=0.
-- Full Sponsorship Hub directory: jobs-portal/sql/directory_employers.sql
--   (list_portal_directory_companies / list_portal_directory_companies_count)

DROP FUNCTION IF EXISTS public.list_portal_companies(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.list_portal_companies_count(text, text);

CREATE OR REPLACE FUNCTION public.list_portal_companies(
  p_catalog text DEFAULT 'uk',
  p_search text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  company_id bigint,
  job_count bigint
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
  SELECT l.company_id::bigint, l.job_count
  FROM live l
  JOIN public.companies c ON c.id::text = l.company_id
  CROSS JOIN q
  WHERE l.job_count > 0
    AND (
      q.search_raw IS NULL
      OR c.trading_name ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.companies_house_name, '') ILIKE '%' || q.search_raw || '%'
    )
  ORDER BY l.job_count DESC, c.trading_name ASC NULLS LAST, l.company_id ASC
  OFFSET GREATEST(coalesce(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
$$;

CREATE OR REPLACE FUNCTION public.list_portal_companies_count(
  p_catalog text DEFAULT 'uk',
  p_search text DEFAULT NULL
)
RETURNS bigint
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
  SELECT COUNT(*)::bigint
  FROM live l
  JOIN public.companies c ON c.id::text = l.company_id
  CROSS JOIN q
  WHERE l.job_count > 0
    AND (
      q.search_raw IS NULL
      OR c.trading_name ILIKE '%' || q.search_raw || '%'
      OR coalesce(c.companies_house_name, '') ILIKE '%' || q.search_raw || '%'
    );
$$;

GRANT EXECUTE ON FUNCTION public.list_portal_companies(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_portal_companies_count(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
