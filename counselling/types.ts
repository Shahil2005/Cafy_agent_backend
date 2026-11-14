export type DurationMinutes = 30 | 45 | 60;

export type CounsellingSlot = {
    startsAt: string;
    endsAt: string;
};

export type BookableMentor = {
    id: number;
    slug: string;
    name: string;
    calHost: 'cal.com' | 'cal.eu';
    calUsername: string;
    calTimezone: string;
    eventSlugForDuration: (duration: DurationMinutes) => string | null;
};

export type CalComBookingResult = {
    uid: string;
    meetingUrl: string | null;
};

export type CounsellingBookingRecord = {
    id: string;
    mentorId: number;
    mentorName: string | null;
    status: string;
    slotStartsAt: string | null;
    slotEndsAt: string | null;
    durationMinutes: number | null;
    meetingUrl: string | null;
    goal: string | null;
    bookedDay: string | null;
    bookedTime: string | null;
    createdAt: string | null;
    reservationExpiresAt?: string | null;
};
