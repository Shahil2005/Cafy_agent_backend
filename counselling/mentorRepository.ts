import type { SupabaseClient } from '@supabase/supabase-js';
import { counsellingShowTestMentors } from '../lib/mentorService';
import type { BookableMentor, DurationMinutes } from './types';

type MentorRow = {
    id: number;
    slug: string;
    name: string;
    is_active: boolean;
    is_test: boolean | null;
    booking_enabled: boolean | null;
    cal_host: string | null;
    cal_username: string | null;
    cal_event_slug_30: string | null;
    cal_event_slug_45: string | null;
    cal_event_slug_60: string | null;
    cal_timezone: string | null;
};

function slugForDuration(row: MentorRow, duration: DurationMinutes): string | null {
    if (duration === 30) return row.cal_event_slug_30?.trim() || null;
    if (duration === 45) return row.cal_event_slug_45?.trim() || null;
    return row.cal_event_slug_60?.trim() || null;
}

function rowToBookableMentor(row: MentorRow): BookableMentor | null {
    const calUsername = row.cal_username?.trim();
    if (!calUsername) return null;

    const calHost: 'cal.com' | 'cal.eu' = row.cal_host === 'cal.eu' ? 'cal.eu' : 'cal.com';

    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        calHost,
        calUsername,
        calTimezone: row.cal_timezone?.trim() || 'Europe/London',
        eventSlugForDuration: (duration: DurationMinutes) => slugForDuration(row, duration),
    };
}

export async function loadBookableMentor(
    db: SupabaseClient,
    mentorId: number
): Promise<BookableMentor | null> {
    const { data, error } = await db
        .from('mentors')
        .select(
            'id, slug, name, is_active, is_test, booking_enabled, cal_host, cal_username, cal_event_slug_30, cal_event_slug_45, cal_event_slug_60, cal_timezone'
        )
        .eq('id', mentorId)
        .maybeSingle();

    if (error || !data) return null;

    const row = data as MentorRow;
    const isTest = row.is_test === true;
    const showTest = counsellingShowTestMentors();

    if (!row.booking_enabled) return null;
    if (isTest && !showTest) return null;
    if (!row.is_active && !(isTest && showTest)) return null;

    return rowToBookableMentor(row);
}

export async function loadMentorIdByCalUsername(
    db: SupabaseClient,
    calUsername: string
): Promise<number | null> {
    const username = calUsername.trim().toLowerCase();
    if (!username) return null;

    const { data, error } = await db
        .from('mentors')
        .select('id, cal_username, booking_enabled')
        .eq('booking_enabled', true);

    if (error || !data?.length) return null;

    const match = (data as Pick<MentorRow, 'id' | 'cal_username' | 'booking_enabled'>[]).find(
        (row) => row.cal_username?.trim().toLowerCase() === username
    );
    return match?.id ?? null;
}

export function mentorHasCalConfig(
    row: Pick<MentorRow, 'cal_username' | 'cal_event_slug_30' | 'cal_event_slug_45' | 'cal_event_slug_60' | 'booking_enabled'>
): boolean {
    return Boolean(
        row.booking_enabled &&
            row.cal_username?.trim() &&
            (row.cal_event_slug_30?.trim() ||
                row.cal_event_slug_45?.trim() ||
                row.cal_event_slug_60?.trim())
    );
}
