-- Career Path SOC index for the gte-small embedding model (Supabase Edge Function inference).
--
-- WHY A SECOND TABLE instead of re-embedding in place: gte-small and all-MiniLM-L6-v2 both
-- output 384 dimensions, so a half-finished migration would pass every dimension check while
-- silently ranking on incomparable vectors (the exact "works locally, breaks in prod" drift
-- this codebase already hit once). Keeping both indexes side by side means:
--   * the MiniLM path keeps working untouched  -> instant rollback
--   * shadow mode can query old and new in the same request and compare
-- Drop uk_soc_occupations only after the chunked path has been live and verified.

create extension if not exists vector;

create table if not exists public.uk_soc_occupations_gte (
    id         bigserial primary key,
    soc_code   text not null unique,
    title      text not null,
    category   text not null,
    embedding  vector(384) not null,
    updated_at timestamptz not null default now()
);

-- NO ivfflat/hnsw index on purpose. The table holds ~412 rows (~633KB of vectors), so an
-- exact sequential scan is sub-millisecond AND exact. An approximate index here would cost
-- recall for no measurable latency gain, and ivfflat with too few lists degrades badly.
-- Add one only if this table grows past a few thousand rows.

comment on table public.uk_soc_occupations_gte is
    'UK SOC 2020 unit groups embedded with gte-small (384d) via Supabase Edge Function AI.';

-- Mirrors match_soc_occupations exactly, including the null skill_level/sponsorship/salary
-- columns: handler.ts re-derives those from data/uk_soc_master.json by soc_code, so the
-- shape must stay identical for the caller to be a drop-in swap.
create or replace function public.match_soc_occupations_gte(
    query_embedding vector(384),
    match_count     int default 50
)
returns table (
    soc_code    text,
    title       text,
    category    text,
    skill_level text,
    sponsorship jsonb,
    salary      jsonb,
    similarity  float
)
language sql
stable
as $$
    select
        o.soc_code,
        o.title,
        o.category,
        null::text  as skill_level,
        null::jsonb as sponsorship,
        null::jsonb as salary,
        1 - (o.embedding <=> query_embedding) as similarity
    from public.uk_soc_occupations_gte o
    order by o.embedding <=> query_embedding
    limit match_count;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and anon/authenticated
-- inherit that - so revoking from those roles alone leaves the RPC callable by anyone holding
-- the project's anon key. PUBLIC must be revoked explicitly, before re-granting to service_role.
revoke all on function public.match_soc_occupations_gte(vector, int) from public;
revoke all on function public.match_soc_occupations_gte(vector, int) from anon, authenticated;
grant execute on function public.match_soc_occupations_gte(vector, int) to service_role;

alter table public.uk_soc_occupations_gte enable row level security;
-- No policies: service_role bypasses RLS, and nothing else should read this table directly.
