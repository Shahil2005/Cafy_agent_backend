-- After CAFY-JOBS-hari/supabase/add_job_catalogue_quality.sql.
-- One match predicate for pagination AND counts. No model, embeddings, or fuzzy SOC inference.
BEGIN;
CREATE OR REPLACE FUNCTION public.match_quality_jobs(
  p_sponsorship_only boolean,
  p_role_query text DEFAULT NULL,p_where_query text DEFAULT NULL,
  p_company_ids integer[] DEFAULT NULL,p_excluded_ids text[] DEFAULT NULL,
  p_excluded_company_ids integer[] DEFAULT NULL,p_company_id integer DEFAULT NULL,
  p_sectors text[] DEFAULT NULL,p_levels text[] DEFAULT NULL,p_job_types text[] DEFAULT NULL
) RETURNS TABLE(job_id bigint,relevance real,preference_rank integer,discovered_at timestamptz)
LANGUAGE sql STABLE SET search_path=public AS $$
 WITH q AS (
   SELECT nullif(btrim(p_role_query),'') role_raw,nullif(btrim(p_where_query),'') where_raw,
     websearch_to_tsquery('english',public.catalogue_search_text(p_role_query)) role_query,
     plainto_tsquery('simple',coalesce(p_where_query,'')) where_query
 )
 SELECT j.id::bigint,
   CASE WHEN q.role_raw IS NULL THEN 0::real
     WHEN public.catalogue_search_text(j.title)=public.catalogue_search_text(q.role_raw) THEN 10::real
     ELSE ts_rank_cd(j.role_document,q.role_query) END,
   CASE
     WHEN j.sector=ANY(p_sectors) AND j.level=ANY(p_levels) AND j.job_type=ANY(p_job_types) THEN 0
     WHEN j.sector=ANY(p_sectors) AND j.job_type=ANY(p_job_types) THEN 1
     WHEN j.sector=ANY(p_sectors) AND j.level=ANY(p_levels) THEN 2
     WHEN j.sector=ANY(p_sectors) THEN 3
     WHEN j.level=ANY(p_levels) AND j.job_type=ANY(p_job_types) THEN 4
     WHEN j.level=ANY(p_levels) THEN 5
     WHEN j.job_type=ANY(p_job_types) THEN 6 ELSE 7 END,
   j.created_at
 FROM public.quality_jobs j CROSS JOIN q
 WHERE (q.role_raw IS NOT NULL OR q.where_raw IS NOT NULL)
   AND (q.role_raw IS NULL OR (numnode(q.role_query)>0 AND j.role_document@@q.role_query))
   AND (q.where_raw IS NULL OR to_tsvector('simple',coalesce(j.location,''))@@q.where_query
     OR j.company_id=ANY(p_company_ids))
   AND (p_excluded_ids IS NULL OR NOT(j.id::text=ANY(p_excluded_ids)))
   AND (p_excluded_company_ids IS NULL OR NOT(j.company_id=ANY(p_excluded_company_ids)))
   AND (p_company_id IS NULL OR j.company_id=p_company_id)
   AND (NOT p_sponsorship_only OR EXISTS(SELECT 1 FROM public.quality_sponsorship_jobs s WHERE s.id=j.id));
$$;

CREATE OR REPLACE FUNCTION public.search_quality_jobs_page(
 p_role_query text DEFAULT NULL,p_where_query text DEFAULT NULL,p_company_ids integer[] DEFAULT NULL,
 p_excluded_ids text[] DEFAULT NULL,p_excluded_company_ids integer[] DEFAULT NULL,p_company_id integer DEFAULT NULL,
 p_offset integer DEFAULT 0,p_limit integer DEFAULT 20,p_sectors text[] DEFAULT NULL,p_levels text[] DEFAULT NULL,p_job_types text[] DEFAULT NULL
) RETURNS TABLE(job_id bigint) LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT m.job_id FROM public.match_quality_jobs(false,p_role_query,p_where_query,p_company_ids,p_excluded_ids,p_excluded_company_ids,p_company_id,p_sectors,p_levels,p_job_types) m
 ORDER BY m.relevance DESC,m.preference_rank,m.discovered_at DESC,m.job_id DESC
 OFFSET greatest(coalesce(p_offset,0),0) LIMIT greatest(least(coalesce(p_limit,20),50),1);
$$;
CREATE OR REPLACE FUNCTION public.search_quality_jobs_count(
 p_role_query text DEFAULT NULL,p_where_query text DEFAULT NULL,p_company_ids integer[] DEFAULT NULL,
 p_excluded_ids text[] DEFAULT NULL,p_excluded_company_ids integer[] DEFAULT NULL,p_company_id integer DEFAULT NULL,
 p_sectors text[] DEFAULT NULL,p_levels text[] DEFAULT NULL,p_job_types text[] DEFAULT NULL
) RETURNS bigint LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT count(*) FROM public.match_quality_jobs(false,p_role_query,p_where_query,p_company_ids,p_excluded_ids,p_excluded_company_ids,p_company_id,p_sectors,p_levels,p_job_types);
$$;
CREATE OR REPLACE FUNCTION public.search_quality_sponsorship_jobs_page(
 p_role_query text DEFAULT NULL,p_where_query text DEFAULT NULL,p_company_ids integer[] DEFAULT NULL,
 p_excluded_ids text[] DEFAULT NULL,p_excluded_company_ids integer[] DEFAULT NULL,p_company_id integer DEFAULT NULL,
 p_offset integer DEFAULT 0,p_limit integer DEFAULT 20,p_sectors text[] DEFAULT NULL,p_levels text[] DEFAULT NULL,p_job_types text[] DEFAULT NULL
) RETURNS TABLE(job_id bigint) LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT m.job_id FROM public.match_quality_jobs(true,p_role_query,p_where_query,p_company_ids,p_excluded_ids,p_excluded_company_ids,p_company_id,p_sectors,p_levels,p_job_types) m
 ORDER BY m.relevance DESC,m.preference_rank,m.discovered_at DESC,m.job_id DESC
 OFFSET greatest(coalesce(p_offset,0),0) LIMIT greatest(least(coalesce(p_limit,20),50),1);
$$;
CREATE OR REPLACE FUNCTION public.search_quality_sponsorship_jobs_count(
 p_role_query text DEFAULT NULL,p_where_query text DEFAULT NULL,p_company_ids integer[] DEFAULT NULL,
 p_excluded_ids text[] DEFAULT NULL,p_excluded_company_ids integer[] DEFAULT NULL,p_company_id integer DEFAULT NULL,
 p_sectors text[] DEFAULT NULL,p_levels text[] DEFAULT NULL,p_job_types text[] DEFAULT NULL
) RETURNS bigint LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT count(*) FROM public.match_quality_jobs(true,p_role_query,p_where_query,p_company_ids,p_excluded_ids,p_excluded_company_ids,p_company_id,p_sectors,p_levels,p_job_types);
$$;
REVOKE ALL ON FUNCTION public.match_quality_jobs(boolean,text,text,integer[],text[],integer[],integer,text[],text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.match_quality_jobs(boolean,text,text,integer[],text[],integer[],integer,text[],text[],text[]) TO service_role;
REVOKE ALL ON FUNCTION public.search_quality_jobs_page(text,text,integer[],text[],integer[],integer,integer,integer,text[],text[],text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.search_quality_jobs_count(text,text,integer[],text[],integer[],integer,text[],text[],text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.search_quality_sponsorship_jobs_page(text,text,integer[],text[],integer[],integer,integer,integer,text[],text[],text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.search_quality_sponsorship_jobs_count(text,text,integer[],text[],integer[],integer,text[],text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_quality_jobs_page(text,text,integer[],text[],integer[],integer,integer,integer,text[],text[],text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_quality_jobs_count(text,text,integer[],text[],integer[],integer,text[],text[],text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_quality_sponsorship_jobs_page(text,text,integer[],text[],integer[],integer,integer,integer,text[],text[],text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_quality_sponsorship_jobs_count(text,text,integer[],text[],integer[],integer,text[],text[],text[]) TO service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
