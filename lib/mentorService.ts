import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveMentorPhotoUrl } from './mentorStorage';
import { isCounsellingEnabled } from '../counselling/config';

/** Local/dev only — never set `COUNSELLING_SHOW_TEST_MENTORS=true` on production. */
export function counsellingShowTestMentors(): boolean {
    return process.env.COUNSELLING_SHOW_TEST_MENTORS === 'true';
}

export type PublicMentor = {
    id: number;
    slug: string;
    name: string;
    quals: string;
    title: string;
    org: string;
    domain: string;
    exp: string;
    linkedin: string;
    photoUrl: string;
    bookingAvailable?: boolean;
    /** Session lengths with a Cal event slug configured (e.g. only 45). */
    availableDurations?: Array<30 | 45 | 60>;
};

type MentorRow = {
    id: number;
    slug: string;
    name: string;
    quals: string | null;
    title: string | null;
    org: string | null;
    domain: string | null;
    exp: string | null;
    linkedin: string | null;
    photo_url: string | null;
    is_test: boolean | null;
    is_active: boolean;
    booking_enabled: boolean | null;
    cal_username: string | null;
    cal_event_slug_30: string | null;
    cal_event_slug_45: string | null;
    cal_event_slug_60: string | null;
};

function isBookingAvailable(row: MentorRow): boolean {
    return Boolean(
        row.booking_enabled &&
            row.cal_username?.trim() &&
            (row.cal_event_slug_30?.trim() ||
                row.cal_event_slug_45?.trim() ||
                row.cal_event_slug_60?.trim())
    );
}

function availableDurationsForMentor(row: MentorRow): Array<30 | 45 | 60> {
    const durations: Array<30 | 45 | 60> = [];
    if (row.cal_event_slug_30?.trim()) durations.push(30);
    if (row.cal_event_slug_45?.trim()) durations.push(45);
    if (row.cal_event_slug_60?.trim()) durations.push(60);
    return durations;
}

export async function fetchActiveMentors(
    dbSupabase: SupabaseClient,
    storageSupabase: SupabaseClient
): Promise<PublicMentor[]> {
    const counsellingOn = isCounsellingEnabled();

    let query = dbSupabase
        .from('mentors')
        .select(
            'id, slug, name, quals, title, org, domain, exp, linkedin, photo_url, is_test, is_active, booking_enabled, cal_username, cal_event_slug_30, cal_event_slug_45, cal_event_slug_60'
        );

    if (counsellingShowTestMentors()) {
        query = query.or('is_active.eq.true,and(is_test.eq.true,booking_enabled.eq.true)');
    } else {
        query = query.eq('is_active', true).eq('is_test', false);
    }

    const { data, error } = await query.order('id');

    if (error) throw error;

    return (data as unknown as MentorRow[]).map((mentor) => {
        const bookingAvailable = counsellingOn ? isBookingAvailable(mentor) : undefined;
        const durations = availableDurationsForMentor(mentor);
        return {
            id: mentor.id,
            slug: mentor.slug,
            name: mentor.name,
            quals: mentor.quals ?? '',
            title: mentor.title ?? '',
            org: mentor.org ?? '',
            domain: mentor.domain ?? '',
            exp: mentor.exp ?? '',
            linkedin: mentor.linkedin ?? '',
            photoUrl: resolveMentorPhotoUrl(storageSupabase, mentor.photo_url),
            ...(counsellingOn
                ? {
                      bookingAvailable,
                      ...(bookingAvailable ? { availableDurations: durations } : {}),
                  }
                : {}),
        };
    });
}
