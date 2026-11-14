# Career Path SOC matching — Supabase Edge Function

Fixes the truncation bug: `all-MiniLM-L6-v2` reads only ~256 tokens (~200 words), so pages 2+
of a resume never reached the query vector. This chunks the whole resume, embeds every window
with `gte-small` inside an Edge Function, searches with each, and keeps every SOC code at its
best score across windows.

## Rollout is flag-gated — nothing changes until you flip it

`CAREER_SOC_CHUNKED` on ProductBackend:

| Value | Behaviour |
|---|---|
| `off` *(default, and the value if unset)* | Current MiniLM single-vector path. Byte-identical to today. |
| `shadow` | Users get today's result. The chunked path runs in parallel and logs a comparison. Its failures can never affect the response. |
| `on` | Chunked path serves users. |

Deploying with the var unset changes nothing for any user. Flipping the value needs no
redeploy and no re-ingest — instant rollback.

## Env vars

ProductBackend (`.env` locally, Vercel dashboard in prod):

```
SOC_EMBED_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/embed-match
SOC_EMBED_SECRET=<long random string>
CAREER_SOC_CHUNKED=off
```

Edge Function secret (set via CLI, see below):

```
SOC_EMBED_SECRET=<the same value>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions automatically.

## Deploy

All of this targets the **RESUME** Supabase project — the one in `RESUME_SUPABASE_URL` that
holds `uk_soc_occupations`. Deploying to the wrong project puts the function in a project with
no SOC table.

```bash
cd cafy-backend/ProductBackend

supabase login
supabase link --project-ref <RESUME project ref>

# 1. table + RPC
supabase db push

# 2. shared secret (must match ProductBackend's SOC_EMBED_SECRET)
supabase secrets set SOC_EMBED_SECRET=<value>

# 3. function
supabase functions deploy embed-match

# 4. build the gte index (~412 rows, ~103 invocations)
npx tsx scripts/ingestSocOccupationsGte.ts
```

Step 4 exits non-zero if the row count doesn't match the dataset — do not enable `shadow`
or `on` until it passes.

## Why two tables

`uk_soc_occupations` (MiniLM) and `uk_soc_occupations_gte` (gte-small) are **both**
`vector(384)`. Same width, incomparable vectors. A single table mid-migration would pass every
dimension check while ranking on garbage — the exact drift this codebase hit once before
(local ONNX ingest vs remote API query).

Two tables means the MiniLM path keeps working untouched, shadow mode can query both in one
request, and rollback is a flag flip.

Drop `uk_soc_occupations` only after `on` has been live and verified.

## The 2s CPU cap

Edge Functions allow **2s of CPU per request**; one `gte-small` embedding costs ~100–200ms.
`MAX_CHUNKS_PER_CALL = 4` (~800ms) leaves headroom for JSON and RPC overhead.

Exceeding it returns **546 WORKER_RESOURCE_LIMIT**. `callEmbedMatch` retries 5xx/429, but if
you see 546s in the logs, lower `MAX_CHUNKS_PER_CALL` in `index.ts` **and** `CHUNKS_PER_CALL`
in `vectorSearch.ts` together — they must stay in sync.

Verify with a real 5-page resume before enabling `on`.

## Known constraints

- **`gte-small` is English-only** per Supabase docs. Non-English CV sections embed poorly.
  MiniLM is also English-centric, so not a regression, but it caps how far this goes.
- **512-token window** — chunks are sized to 2000 chars to fit; don't raise `CHUNK_CHARS`
  without checking that.
- **`MIN_TOP_SIMILARITY` is calibrated for MiniLM.** gte-small has a different score
  distribution. Retune from `shadow` logs before enabling `on`, via
  `CAREER_SOC_MIN_TOP_SIMILARITY`.

## Reading shadow logs

```
[career-analysis] SHADOW legacyTop=0.3112 chunkedTop=0.6841 overlap=18/50
  chunks=10 chars=16204/16204 legacyStatus=fulfilled
  legacyCodes=[4159,2133,...] chunkedCodes=[2136,2133,...]
```

- `chunkedTop` vs `legacyTop` → the score distribution you'll set the new floor from
- `overlap` → how much the shortlist actually moves (low overlap = big report change)
- `chars=a/b` → embedding coverage; `a < b` means the 30-chunk cap truncated
