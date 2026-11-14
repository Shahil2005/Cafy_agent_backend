import { z } from 'zod';

export const durationMinutesSchema = z.union([z.literal(30), z.literal(45), z.literal(60)]);

export const availabilityQuerySchema = z.object({
    mentorId: z.coerce.number().int().positive(),
    durationMinutes: z.coerce.number().pipe(durationMinutesSchema),
});

export const bookSessionBodySchema = z.object({
    mentorId: z.number().int().positive(),
    durationMinutes: durationMinutesSchema,
    slotStartsAt: z.string().min(10),
    goal: z.string().max(2000).optional(),
});

export const reserveSlotBodySchema = z.object({
    mentorId: z.number().int().positive(),
    durationMinutes: durationMinutesSchema,
    slotStartsAt: z.string().min(10),
});

export const bookingIdSchema = z.string().min(1);

export const confirmReservationBodySchema = z.object({
    reservationId: bookingIdSchema,
    goal: z.string().max(2000).optional(),
    attendeeTimeZone: z.string().max(64).optional(),
});

export const cancelReservationBodySchema = z.object({
    reservationId: bookingIdSchema,
});

export const counsellingCheckoutBodySchema = z.object({
    reservationId: bookingIdSchema,
    goal: z.string().max(2000).optional(),
    attendeeTimeZone: z.string().max(64).optional(),
});

export const confirmPaymentBodySchema = z.object({
    sessionId: z.string().min(1).max(256),
});
