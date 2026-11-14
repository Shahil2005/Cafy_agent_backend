-- Search companies by brand (display/trading name) or Companies House / legal name.
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

NOTIFY pgrst, 'reload schema';
