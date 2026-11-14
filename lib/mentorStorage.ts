import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const MENTOR_PHOTOS_BUCKET = process.env.MENTOR_PHOTOS_BUCKET || 'mentor-photos';

export function createResumeSupabaseClient(): SupabaseClient {
    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error('RESUME_SUPABASE_URL and RESUME_SUPABASE_SERVICE_ROLE_KEY are required for mentor photos');
    }

    return createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

export function resolveMentorPhotoUrl(
    storageSupabase: SupabaseClient,
    photoUrl: string | null | undefined
): string {
    if (!photoUrl?.trim()) return '';

    const trimmed = photoUrl.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }

    const path = trimmed.replace(/^\/+/, '');
    const { data } = storageSupabase.storage.from(MENTOR_PHOTOS_BUCKET).getPublicUrl(path);
    return data.publicUrl;
}
