-- CAFY: READ-ONLY export of the structure of the jobs tables (no data rows).
--
-- Run in the LIVE Supabase project: SQL Editor -> paste -> Run -> Export / Download CSV.
-- Save the file as ProductBackend-main/scripts/dev/live_jobs_schema.csv
--
-- This is a single SELECT. It only reads the database catalogue (table columns, indexes,
-- search functions, security policies). It changes nothing and reads no user data.
-- It is used to build the same structure in the TESTING project.

with wanted(name) as (
    values ('jobs'), ('jobs_IR'), ('part_time_jobs_UK'), ('part_time_companies_UK'), ('companies'), ('directory_employers'), ('job_reports')
),
rel as (
    select c.oid, c.relname::text as relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join wanted w on w.name = c.relname
    where n.nspname = 'public' and c.relkind in ('r', 'p')
)
select kind, name, detail::text as detail
from (
    select 1 as ord, 'extension'::text as kind, e.extname::text as name, json_build_object('schema', n.nspname) as detail
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname <> 'plpgsql'

    union all
    select 2, 'enum', ty.typname::text, json_build_object('values', (select json_agg(en.enumlabel order by en.enumsortorder) from pg_enum en where en.enumtypid = ty.oid))
    from pg_type ty join pg_namespace n on n.oid = ty.typnamespace
    where n.nspname = 'public' and ty.typtype = 'e'

    union all
    select 3, 'sequence', s.relname::text, json_build_object('owner', (select r.relname from pg_depend d join rel r on r.oid = d.refobjid where d.objid = s.oid and d.deptype in ('a', 'i') limit 1))
    from pg_class s join pg_namespace n on n.oid = s.relnamespace
    where n.nspname = 'public' and s.relkind = 'S'

    union all
    select 4, 'table', r.relname, json_build_object('rls', r.relrowsecurity, 'forceRls', r.relforcerowsecurity)
    from rel r

    union all
    select 5, 'column', r.relname || '.' || a.attname, json_build_object(
        'table', r.relname,
        'column', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'notNull', a.attnotnull,
        'default', case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end,
        'generated', case when a.attgenerated = 's' then pg_get_expr(d.adbin, d.adrelid) end,
        'identity', nullif(a.attidentity::text, ''),
        'position', a.attnum)
    from rel r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum

    union all
    select 6, 'constraint', con.conname::text, json_build_object('table', r.relname, 'type', con.contype, 'def', pg_get_constraintdef(con.oid))
    from rel r join pg_constraint con on con.conrelid = r.oid

    union all
    select 7, 'index', i.indexname::text, json_build_object('table', i.tablename, 'def', i.indexdef)
    from pg_indexes i join wanted w on w.name = i.tablename
    where i.schemaname = 'public'

    union all
    select 8, 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', json_build_object('def', pg_get_functiondef(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')

    union all
    select 9, 'trigger', tg.tgname::text, json_build_object('table', r.relname, 'def', pg_get_triggerdef(tg.oid))
    from rel r join pg_trigger tg on tg.tgrelid = r.oid and not tg.tgisinternal

    union all
    select 10, 'policy', pol.policyname::text, json_build_object('table', pol.tablename, 'permissive', pol.permissive, 'roles', pol.roles, 'cmd', pol.cmd, 'qual', pol.qual, 'withCheck', pol.with_check)
    from pg_policies pol join wanted w on w.name = pol.tablename
    where pol.schemaname = 'public'
) x
order by ord, name;
