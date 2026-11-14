import { createClient } from '@supabase/supabase-js';

const RESUME_SUPABASE_URL = process.env.RESUME_SUPABASE_URL || '';
const RESUME_SUPABASE_SERVICE_ROLE_KEY = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY || '';

if (!RESUME_SUPABASE_URL || !RESUME_SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('RESUME_SUPABASE credentials not found — resume storage disabled');
}

// Only initialise if credentials are present — avoids crash when running jobs-portal only
const resumeSupabase = (RESUME_SUPABASE_URL && RESUME_SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(RESUME_SUPABASE_URL, RESUME_SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null as any;

const BUCKET_NAME = 'ProductResumes';
const MAX_FILENAME_LEN = 180;

/**
 * Sanitize a single filename segment for Supabase Storage.
 * Strips characters that cause 400s (e.g. [], spaces, unicode punctuation).
 */
export function sanitizeStorageFilename(filename: string): string {
  const trimmed = String(filename || '').trim();
  const lastDot = trimmed.lastIndexOf('.');
  const base = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  const ext = lastDot > 0 ? trimmed.slice(lastDot + 1) : '';

  let safeBase = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '') || 'resume';

  const safeExt = ext.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  const maxBase = Math.max(1, MAX_FILENAME_LEN - (safeExt ? safeExt.length + 1 : 0));
  if (safeBase.length > maxBase) safeBase = safeBase.slice(0, maxBase).replace(/[._-]+$/g, '') || 'resume';

  return safeExt ? `${safeBase}.${safeExt}` : safeBase;
}

/**
 * Sanitize only the object filename; leave folder prefixes (e.g. userId/) unchanged
 * so ownership checks stay exact.
 */
export function sanitizeStorageObjectPath(objectPath: string): string {
  const normalized = String(objectPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return sanitizeStorageFilename('resume');
  const filename = parts.pop()!;
  return [...parts, sanitizeStorageFilename(filename)].join('/');
}

/**
 * Generates a short-lived signed URL for a file in Supabase Storage.
 */
export const getSignedUrl = async (path: string, expiresIn: number = 300) => {
  const { data, error } = await resumeSupabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(path, expiresIn);

  if (error) {
    console.error('Error generating signed URL:', error);
    throw error;
  }

  return data.signedUrl;
};

/**
 * Uploads a file to Supabase Storage.
 * Expects file data as a Buffer or base64 string.
 */
export const uploadFile = async (path: string, fileData: Buffer | string, contentType: string) => {
  if (!resumeSupabase) {
    throw new Error('RESUME_STORAGE_NOT_CONFIGURED');
  }

  const body = typeof fileData === 'string' ? Buffer.from(fileData, 'base64') : fileData;
  
  const { data, error } = await resumeSupabase.storage
    .from(BUCKET_NAME)
    .upload(path, body, {
      contentType,
      upsert: true
    });

  if (error) {
    console.error('Error uploading file to Supabase:', error);
    throw error;
  }

  return data;
};

/**
 * Deletes a file from Supabase Storage.
 */
export const deleteFile = async (path: string) => {
  const { data, error } = await resumeSupabase.storage
    .from(BUCKET_NAME)
    .remove([path]);

  if (error) {
    console.error('Error deleting file from Supabase:', error);
    throw error;
  }

  return data;
};

/**
 * Recursively delete every object under `{uid}/` in ProductResumes.
 * Best-effort: missing bucket / empty folder returns 0.
 */
export async function deleteUserStorageFolder(uid: string): Promise<number> {
  if (!resumeSupabase) return 0;
  const safeUid = String(uid || '').trim();
  if (!safeUid || safeUid.includes('/') || safeUid.includes('..')) {
    throw new Error('INVALID_STORAGE_UID');
  }

  let deleted = 0;

  const wipe = async (prefix: string): Promise<void> => {
    const { data, error } = await resumeSupabase.storage.from(BUCKET_NAME).list(prefix, {
      limit: 1000,
    });
    if (error) {
      console.warn('[storage] list folder failed:', prefix, error.message);
      return;
    }
    if (!data || data.length === 0) return;

    const filePaths: string[] = [];
    for (const entry of data) {
      const child = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Supabase folders usually have id === null; files have an id.
      if (entry.id) {
        filePaths.push(child);
      } else {
        await wipe(child);
      }
    }

    if (filePaths.length > 0) {
      const { error: removeError } = await resumeSupabase.storage.from(BUCKET_NAME).remove(filePaths);
      if (removeError) {
        console.warn('[storage] remove batch failed:', removeError.message);
      } else {
        deleted += filePaths.length;
      }
    }
  };

  await wipe(safeUid);
  return deleted;
}

/**
 * Downloads a file from Supabase Storage as a buffer.
 */
export const downloadFile = async (path: string): Promise<Buffer> => {
  if (!resumeSupabase) {
    throw new Error('RESUME_STORAGE_NOT_CONFIGURED');
  }

  const { data, error } = await resumeSupabase.storage
    .from(BUCKET_NAME)
    .download(path);

  if (error) {
    throw error;
  }

  return Buffer.from(await data.arrayBuffer());
};
