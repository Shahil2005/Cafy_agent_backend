-- Market-specific Ireland sponsor flag (separate from UK Home Office licensed_sponsor).
-- Apply in Supabase SQL editor before deploying portal code that selects this column.
--
-- Semantics:
--   licensed_sponsor          = UK Home Office Worker / Temporary Worker licence
--   ireland_permit_employer   = appears on Ireland DETE employment-permits register
--
-- Note: does NOT require companies.sync_market. Ireland imports are identified by
-- id >= 900000 (project convention). If you later add sync_market, re-run the
-- optional block at the bottom.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ireland_permit_employer BOOLEAN NOT NULL DEFAULT false;

-- Ireland-seeded companies (id range used by ireland imports) historically reused
-- licensed_sponsor=true for the Irish badge. Promote that onto the Ireland column.
UPDATE public.companies
SET ireland_permit_employer = true
WHERE ireland_permit_employer = false
  AND id ~ '^[0-9]+$'
  AND id::bigint >= 900000;

-- Pure Ireland imports are not UK Home Office sponsors by default.
UPDATE public.companies
SET licensed_sponsor = false
WHERE id ~ '^[0-9]+$'
  AND id::bigint >= 900000;

CREATE INDEX IF NOT EXISTS idx_companies_ireland_permit_employer
  ON public.companies (ireland_permit_employer)
  WHERE ireland_permit_employer = true;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- OPTIONAL: only if sync_market already exists on companies.
-- Uncomment after running supabase/add_ireland_source_and_market.sql
-- ---------------------------------------------------------------------------
-- UPDATE public.companies
-- SET ireland_permit_employer = true
-- WHERE ireland_permit_employer = false
--   AND lower(coalesce(sync_market, '')) IN ('ireland', 'both');
--
-- UPDATE public.companies
-- SET licensed_sponsor = false
-- WHERE lower(coalesce(sync_market, '')) = 'ireland'
--   AND id ~ '^[0-9]+$'
--   AND id::bigint >= 900000;
