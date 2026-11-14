-- CAFY: frees space in the TESTING database by removing the 5 backup tables made on 2026-11-02
-- (the old testing jobs from 9 Oct, kept when the live jobs were copied in). Approved by the
-- product owner. Run in TESTING only. Removes nothing else; live is never touched.
BEGIN;

DO $cafy$ BEGIN
  IF to_regclass('public.mentors') IS NOT NULL OR to_regclass('public.cafy_testing_replica') IS NULL THEN
    RAISE EXCEPTION 'STOP: this is not the testing database. Nothing was changed.';
  END IF;
END $cafy$;

-- CASCADE also removes links from other old testing tables (e.g. user_applied_jobs, empty) to these backups.
DROP TABLE IF EXISTS public."jobs_backup_20261102" CASCADE;
DROP TABLE IF EXISTS public."jobs_IR_backup_20261102" CASCADE;
DROP TABLE IF EXISTS public."part_time_jobs_UK_backup_20261102" CASCADE;
DROP TABLE IF EXISTS public."part_time_companies_UK_backup_20261102" CASCADE;
DROP TABLE IF EXISTS public."companies_backup_20261102" CASCADE;

COMMIT;

-- Space after the change (Postgres frees it gradually; this shows the current size):
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
