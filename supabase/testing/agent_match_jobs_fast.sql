-- CAFY chat agent: a faster trial of the job ranking, for the small free TESTING database only.
-- Adds one NEW table, one NEW function and a trigger on the agent's own agent_job_pieces table. Changes no
-- existing function and no CAFY table. The agent uses this only when AGENT_FAST_RANK=1 is set, after
-- scripts/agent/compareFastRank.ts shows the results match the exact ranking.
-- Undo: DROP TRIGGER agent_job_pieces_bits_sync ON public.agent_job_pieces; DROP FUNCTION public.agent_job_pieces_bits_sync();
--       DROP FUNCTION public.agent_match_jobs_fast(jsonb, text[], numeric, jsonb, integer, integer); DROP TABLE public.agent_job_piece_bits;
-- Reads every piece once while filling, so run it only when the disk budget has refilled.
-- The trigger keeps the compact copy in step with every later insert, update and delete of a piece (embedJobs.ts,
-- and later the CAFY-JOBS sync), so new jobs are never missing from the fast ranking. Re-running this file is safe.
BEGIN;

DO $cafy$ BEGIN
  IF to_regclass('public.mentors') IS NOT NULL OR to_regclass('public.cafy_testing_replica') IS NULL OR to_regclass('public.agent_job_pieces') IS NULL THEN
    RAISE EXCEPTION 'STOP: this is not the testing database. Nothing was changed.';
  END IF;
END $cafy$;

SET LOCAL statement_timeout = '10min';

-- One compact copy of each piece's meaning vector: 48 bytes instead of about 770.
-- An older trial version of this table had no piece number; it is rebuilt with one.
DO $cafy$ BEGIN
  IF to_regclass('public.agent_job_piece_bits') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_job_piece_bits' AND column_name = 'piece_no') THEN
    DROP TABLE public.agent_job_piece_bits;
  END IF;
END $cafy$;
CREATE TABLE IF NOT EXISTS public.agent_job_piece_bits (
  source   text      NOT NULL,
  job_id   bigint    NOT NULL,
  piece_no smallint  NOT NULL,
  bits     bit(384)  NOT NULL,
  PRIMARY KEY (source, job_id, piece_no)
);
ALTER TABLE public.agent_job_piece_bits ENABLE ROW LEVEL SECURITY;

TRUNCATE public.agent_job_piece_bits;
INSERT INTO public.agent_job_piece_bits (source, job_id, piece_no, bits)
SELECT source, job_id, piece_no, binary_quantize(embedding)::bit(384) FROM public.agent_job_pieces;

-- Keeps the compact copy in step with agent_job_pieces (the agent's own table), row by row.
CREATE OR REPLACE FUNCTION public.agent_job_pieces_bits_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM public.agent_job_piece_bits
    WHERE source = OLD.source AND job_id = OLD.job_id AND piece_no = OLD.piece_no;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO public.agent_job_piece_bits (source, job_id, piece_no, bits)
    VALUES (NEW.source, NEW.job_id, NEW.piece_no, binary_quantize(NEW.embedding)::bit(384))
    ON CONFLICT (source, job_id, piece_no) DO UPDATE SET bits = EXCLUDED.bits;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.agent_job_pieces_bits_sync() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS agent_job_pieces_bits_sync ON public.agent_job_pieces;
CREATE TRIGGER agent_job_pieces_bits_sync
AFTER INSERT OR UPDATE OR DELETE ON public.agent_job_pieces
FOR EACH ROW EXECUTE FUNCTION public.agent_job_pieces_bits_sync();

CREATE OR REPLACE FUNCTION public.agent_match_jobs_fast(
  p_query jsonb,
  p_keywords text[] DEFAULT '{}',
  p_cv_years numeric DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 20,
  p_shortlist integer DEFAULT 500
)
RETURNS TABLE (job_id bigint, meaning real, keyword real, seniority text, band integer)
LANGUAGE sql STABLE
-- 45s, just past the backend's 42s wait, so abandoned searches stop instead of slowing the next one. Only for the accuracy check on the small free testing database; set back to 20s before any real use.
SET statement_timeout = '45s'
SET work_mem = '32MB'
AS $$
-- MATERIALIZED: compute these once. Inlined, Postgres re-reads the vectors and filters for every row and takes minutes.
WITH q AS MATERIALIZED (
  SELECT (e->>'v')::halfvec(384) AS v, binary_quantize((e->>'v')::halfvec(384))::bit(384) AS bits, greatest(coalesce((e->>'w')::real, 1), 0.01) AS w, ord
  FROM jsonb_array_elements(p_query) WITH ORDINALITY AS t(e, ord)
),
f AS MATERIALIZED (
  SELECT lower(nullif(btrim(p_filters->>'location'), '')) AS loc,
         coalesce(ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(p_filters->'exclude_locations') x), '{}') AS no_locs,
         (p_filters->>'remote')::boolean AS remote,
         (p_filters->>'hybrid')::boolean AS hybrid,
         coalesce(ARRAY(SELECT jsonb_array_elements_text(p_filters->'job_types')), '{}') AS job_types,
         (p_filters->>'min_pay')::integer AS min_pay,
         (p_filters->>'visa')::boolean AS visa,
         coalesce(ARRAY(SELECT jsonb_array_elements_text(p_filters->'sectors')), '{}') AS sectors,
         coalesce(ARRAY(SELECT (jsonb_array_elements_text(p_filters->'company_ids'))::integer), '{}') AS company_ids,
         (p_filters->>'posted_within_days')::integer AS days,
         coalesce(ARRAY(SELECT (jsonb_array_elements_text(p_filters->'exclude_job_ids'))::bigint), '{}') AS no_jobs,
         coalesce(ARRAY(SELECT (jsonb_array_elements_text(p_filters->'exclude_company_ids'))::integer), '{}') AS no_companies
),
jobs_ok AS MATERIALIZED (
  SELECT j.id
  FROM public.jobs j, f
  WHERE (f.loc IS NULL
         OR strpos(lower(coalesce(j.location, '')), f.loc) > 0
         OR EXISTS (SELECT 1 FROM unnest(coalesce(j.all_locations, '{}')) a WHERE strpos(lower(a), f.loc) > 0)
         -- Generic location ("United Kingdom"): the town is often only in the advert text.
         OR (coalesce(j.location, '') ~* '^\s*(united kingdom|uk|england|scotland|wales|gb)?\s*$'
             AND strpos(lower(left(coalesce(j.description, ''), 6000)), f.loc) > 0))
    AND NOT EXISTS (SELECT 1 FROM unnest(f.no_locs) x WHERE strpos(lower(coalesce(j.location, '')), x) > 0)
    AND (f.remote IS NOT TRUE
         OR coalesce(j.location, '') ~* '\mremote\M'
         OR coalesce(j.description, '') ~* '(fully remote|remote[- ]first|remote[- ]based|remote (role|position|working|job)|100% remote|work(ing)? from home|home[- ]based role)')
    AND (f.hybrid IS NOT TRUE
         OR coalesce(j.location, '') ~* '\mhybrid\M'
         OR coalesce(j.description, '') ~* 'hybrid (working|role|position|model|pattern|basis|arrangement)')
    AND (cardinality(f.job_types) = 0 OR j.job_type = ANY (f.job_types))
    AND (f.min_pay IS NULL OR public.agent_job_pay(j.salary, j.description) >= f.min_pay)
    -- "Needs a visa" removes only jobs already found NOT eligible; "not sure" stays.
    AND (f.visa IS NOT TRUE OR coalesce(j.sponsorship_outcome, '') <> 'not_eligible')
    AND (cardinality(f.sectors) = 0 OR j.department = ANY (f.sectors) OR j.sector = ANY (f.sectors))
    AND (cardinality(f.company_ids) = 0 OR j.company_id = ANY (f.company_ids))
    AND (f.days IS NULL OR j.created_at >= now() - make_interval(days => f.days))
    AND NOT (j.id = ANY (f.no_jobs))
    AND (j.company_id IS NULL OR NOT (j.company_id = ANY (f.no_companies)))
),
-- First pass: rough score from the compact copy of every piece, to shortlist the jobs worth comparing exactly.
rough AS MATERIALIZED (
  SELECT r.job_id
  FROM (
    SELECT b.job_id, q.ord, q.w, max(1 - (b.bits <~> q.bits) / 384.0) AS s
    FROM public.agent_job_piece_bits b
    JOIN jobs_ok o ON o.id = b.job_id
    CROSS JOIN q
    WHERE b.source = 'uk'
    GROUP BY b.job_id, q.ord, q.w
  ) r
  GROUP BY r.job_id
  ORDER BY sum(r.s * r.w) / sum(r.w) DESC
  LIMIT greatest(least(p_shortlist, 5000), 100)
),
best AS (
  -- For each job and each query vector: its best partner piece.
  -- The score is worked out first (OFFSET 0 keeps it here) so the grouping never carries the 800-byte vectors.
  SELECT d.job_id, d.ord, d.w, max(d.s) AS s
  FROM (
    SELECT p.job_id, q.ord, q.w, 1 - (p.embedding <=> q.v) AS s
    FROM public.agent_job_pieces p
    JOIN rough o ON o.job_id = p.job_id
    CROSS JOIN q
    WHERE p.source = 'uk'
    OFFSET 0
  ) d
  GROUP BY d.job_id, d.ord, d.w
),
scored AS (
  SELECT b.job_id, (sum(b.s * b.w) / sum(b.w))::real AS meaning
  FROM best b
  GROUP BY b.job_id
  ORDER BY 2 DESC
  LIMIT 100
),
role_text AS (
  -- Keywords are looked for in the title and the full description.
  SELECT s.job_id, s.meaning, j.title, j.company_id,
         j.title || ' ' || coalesce(j.department, '') || ' ' || coalesce(j.description, '') AS txt
  FROM scored s
  JOIN public.jobs j ON j.id = s.job_id
),
kw AS (
  SELECT r.job_id,
         CASE WHEN cardinality(p_keywords) = 0 THEN 0::real ELSE (sum(
           CASE WHEN k IS NULL THEN 0
                WHEN r.txt ~* ('\m' || regexp_replace(k, '([.^$*+?(){}\[\]\\|])', '\\\1', 'g') || '\M') THEN 1.0
                WHEN length(k) >= 5 AND word_similarity(lower(k), lower(r.txt)) >= 0.7 THEN 0.8
                ELSE 0 END) / cardinality(p_keywords))::real END AS keyword
  FROM role_text r
  LEFT JOIN unnest(p_keywords) AS k ON true
  GROUP BY r.job_id
),
lvl AS (
  SELECT r.job_id, r.meaning, k.keyword, r.title, r.company_id,
         CASE
           WHEN p_cv_years IS NULL THEN NULL
           -- "Staff" alone is not senior (Staff Nurse); "Staff Engineer" is.
           WHEN (r.title ~* '\m(senior|sr|lead|principal|head of|director|chief|vp|vice president)\M'
                 OR r.title ~* '\mstaff\s+(\w+\s+)?(engineer|developer|scientist|architect)\M') AND p_cv_years < 5 THEN 'too_senior'
           -- "Software Engineer III": a numbered grade above entry level.
           WHEN r.title ~* '\m(ii|iii|iv)\M' AND p_cv_years < 2 THEN 'too_senior'
           WHEN r.title ~* '\m(graduate|junior|jr|entry[- ]level|trainee|intern|internship|apprentice|apprenticeship)\M' AND p_cv_years >= 4 THEN 'too_junior'
           WHEN (substring(r.txt FROM '(?i)(\d{1,2})\s*\+?\s*(?:years|yrs)[^.\n]{0,40}experience'))::integer >= p_cv_years + 2 THEN 'too_senior'
         END AS seniority
  FROM role_text r
  JOIN kw k ON k.job_id = r.job_id
),
ranked AS (
  SELECT l.*,
         floor((l.meaning - CASE WHEN l.seniority IS NULL THEN 0 ELSE 0.01 END) * 200)::integer AS band,
         coalesce(l.company_id::text, l.job_id::text) || '|' || btrim(lower(regexp_replace(l.title, '[(\[][^)\]]*[)\]]', ' ', 'g'))) AS same_role
  FROM lvl l
),
one_each AS (
  SELECT DISTINCT ON (r.same_role) r.*
  FROM ranked r
  ORDER BY r.same_role, r.band DESC, r.keyword DESC, r.meaning DESC
),
one_advert AS (
  -- One advert listed under two company names: same title and the same score, so the same text.
  SELECT DISTINCT ON (lower(o.title), round(o.meaning::numeric, 4)) o.*
  FROM one_each o
  ORDER BY lower(o.title), round(o.meaning::numeric, 4), o.job_id DESC
)
SELECT o.job_id, o.meaning, o.keyword, o.seniority, o.band
FROM one_advert o
ORDER BY o.band DESC, o.keyword DESC, o.meaning DESC
LIMIT greatest(least(p_limit, 50), 1);
$$;

-- Server only, like the exact ranking.
REVOKE ALL ON FUNCTION public.agent_match_jobs_fast(jsonb, text[], numeric, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_match_jobs_fast(jsonb, text[], numeric, jsonb, integer, integer) TO service_role;
REVOKE ALL ON public.agent_job_piece_bits FROM PUBLIC, anon, authenticated;

COMMIT;

SELECT (SELECT count(*) FROM public.agent_job_piece_bits) AS pieces_copied,
       (SELECT count(*) FROM public.agent_job_pieces) AS pieces_total,
       pg_size_pretty(pg_total_relation_size('public.agent_job_piece_bits')) AS table_size,
       pg_size_pretty(pg_database_size(current_database())) AS whole_db_size;
