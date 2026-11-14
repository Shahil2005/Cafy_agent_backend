/**
 * Audit Firebase Storage usage: top folders + largest files.
 *
 * Uses FIREBASE_SERVICE_ACCOUNT from ProductBackend .env
 * and bucket cafy-7f409.firebasestorage.app (override with STORAGE_BUCKET).
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/_storageAudit.ts
 */
import '../env';
import * as admin from 'firebase-admin';

function initAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    storageBucket: process.env.STORAGE_BUCKET || 'cafy-7f409.firebasestorage.app',
  });
}

function mb(bytes: number) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function gb(bytes: number) {
  return Number((bytes / (1024 * 1024 * 1024)).toFixed(3));
}

function topFolder(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '(root)' : path.slice(0, i);
}

async function main() {
  initAdmin();
  const bucketName =
    process.env.STORAGE_BUCKET || 'cafy-7f409.firebasestorage.app';
  const bucket = admin.storage().bucket(bucketName);

  console.error(`Listing gs://${bucketName} …`);

  const [files] = await bucket.getFiles({ autoPaginate: true });

  let totalBytes = 0;
  const byFolder: Record<string, { n: number; bytes: number }> = {};
  const largest: Array<{ name: string; bytes: number; updated?: string }> = [];

  for (const f of files) {
    const size = Number(f.metadata?.size || 0);
    totalBytes += size;
    const folder = topFolder(f.name);
    byFolder[folder] ||= { n: 0, bytes: 0 };
    byFolder[folder].n += 1;
    byFolder[folder].bytes += size;
    largest.push({
      name: f.name,
      bytes: size,
      updated: f.metadata?.updated,
    });
  }

  largest.sort((a, b) => b.bytes - a.bytes);

  const folders = Object.entries(byFolder)
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
        bucket: bucketName,
        fileCount: files.length,
        totalMb: mb(totalBytes),
        totalGb: gb(totalBytes),
        topFolders: folders.slice(0, 30),
        largestFiles: largest.slice(0, 40).map((f) => ({
          name: f.name,
          mb: mb(f.bytes),
          updated: f.updated?.slice(0, 10) ?? null,
        })),
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
