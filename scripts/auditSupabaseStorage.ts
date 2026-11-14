/**
 * Audit Supabase Storage for an external project.
 *
 * 1. Paste keys into scripts/.env.storage-audit
 * 2. Run: npx ts-node --transpile-only scripts/auditSupabaseStorage.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env) || !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function mb(bytes: number) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function gb(bytes: number) {
  return Number((bytes / (1024 * 1024 * 1024)).toFixed(3));
}

type ListedItem = {
  id: string | null;
  name: string;
  metadata?: { size?: number } | null;
  updated_at?: string | null;
};

async function listAllInPrefix(
  supabase: SupabaseClient<any, 'public', 'public', any, any>,
  bucket: string,
  prefix: string
): Promise<Array<{ path: string; bytes: number; updated: string | null }>> {
  const out: Array<{ path: string; bytes: number; updated: string | null }> = [];
  const queue = [prefix];

  while (queue.length) {
    const current = queue.shift()!;
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(bucket).list(current || undefined, {
        limit: 100,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`[${bucket}] list "${current}": ${error.message}`);
      const items = (data || []) as ListedItem[];
      if (!items.length) break;

      for (const item of items) {
        const childPath = current ? `${current}/${item.name}` : item.name;
        if (item.id == null) {
          queue.push(childPath);
          continue;
        }
        out.push({
          path: childPath,
          bytes: Number(item.metadata?.size || 0),
          updated: item.updated_at ?? null,
        });
      }

      if (items.length < 100) break;
      offset += 100;
    }
  }

  return out;
}

async function main() {
  const auditEnvPath = path.join(__dirname, '.env.storage-audit');
  const backendEnvPath = path.join(__dirname, '..', '.env');
  // Prefer dedicated audit env; fall back to ProductBackend .env (supports OLD_SUPABASE_*).
  if (fs.existsSync(auditEnvPath)) loadEnvFile(auditEnvPath);
  if (fs.existsSync(backendEnvPath)) loadEnvFile(backendEnvPath);

  // Prefer dedicated OLD_* / audit-file values for the external project.
  // Do not fall back to ProductBackend SUPABASE_* (that's Cafy's jobs DB).
  const url = (
    process.env.STORAGE_AUDIT_SUPABASE_URL ||
    process.env.OLD_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  ).trim();
  const key = (
    process.env.STORAGE_AUDIT_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.OLD_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
  if (!url || !key) {
    throw new Error(
      `Set OLD_SUPABASE_URL + OLD_SUPABASE_SERVICE_ROLE_KEY in ProductBackend/.env, or fill scripts/.env.storage-audit`
    );
  }
  // Reject anon keys early — storage listing needs service_role.
  try {
    const payload = JSON.parse(
      Buffer.from(key.split('.')[1], 'base64url').toString('utf8')
    );
    if (payload.role && payload.role !== 'service_role') {
      throw new Error(
        `Key role is "${payload.role}". Use the service_role key from Supabase → Settings → API.`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Key role')) throw e;
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
  if (bucketsError) throw new Error(`listBuckets: ${bucketsError.message}`);

  const bucketSummaries: Array<{
    bucket: string;
    public: boolean;
    files: number;
    totalMb: number;
    totalGb: number;
  }> = [];
  const largest: Array<{ bucket: string; path: string; mb: number; updated: string | null }> = [];
  const byTopFolder: Record<string, { n: number; bytes: number }> = {};

  let grandBytes = 0;
  let grandFiles = 0;

  for (const bucket of buckets || []) {
    console.error(`Scanning bucket: ${bucket.name}`);
    const files = await listAllInPrefix(supabase, bucket.name, '');
    let bytes = 0;
    for (const f of files) {
      bytes += f.bytes;
      grandBytes += f.bytes;
      grandFiles += 1;
      largest.push({
        bucket: bucket.name,
        path: f.path,
        mb: mb(f.bytes),
        updated: f.updated ? f.updated.slice(0, 10) : null,
      });
      const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(root)';
      const keyFolder = `${bucket.name}/${top}`;
      byTopFolder[keyFolder] ||= { n: 0, bytes: 0 };
      byTopFolder[keyFolder].n += 1;
      byTopFolder[keyFolder].bytes += f.bytes;
    }
    bucketSummaries.push({
      bucket: bucket.name,
      public: Boolean(bucket.public),
      files: files.length,
      totalMb: mb(bytes),
      totalGb: gb(bytes),
    });
  }

  largest.sort((a, b) => b.mb - a.mb);
  const folders = Object.entries(byTopFolder)
    .map(([folder, v]) => ({
      folder,
      files: v.n,
      mb: mb(v.bytes),
      gb: gb(v.bytes),
    }))
    .sort((a, b) => b.mb - a.mb);

  console.log(
    JSON.stringify(
      {
        projectUrl: url,
        buckets: bucketSummaries.sort((a, b) => b.totalMb - a.totalMb),
        totals: {
          files: grandFiles,
          totalMb: mb(grandBytes),
          totalGb: gb(grandBytes),
        },
        topFolders: folders.slice(0, 40),
        largestFiles: largest.slice(0, 50),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
