import { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPremiumActive, refreshSubscriptionIfExpired } from '../billing/subscriptionService';
import { counsellingBookingLimiter } from '../middleware/rateLimiters';
import { captureServerError } from '../lib/observability/sentry';
import { isCounsellingEnabled } from './config';
import { createCounsellingCheckoutSession } from './checkoutService';
import { syncCounsellingPaymentFromCheckoutSession } from './confirmPaymentService';
import {
    availabilityQuerySchema,
    bookSessionBodySchema,
    cancelReservationBodySchema,
    confirmPaymentBodySchema,
    confirmReservationBodySchema,
    counsellingCheckoutBodySchema,
    reserveSlotBodySchema,
} from './schema';
import {
    bookSessionWithoutPayment,
    cancelCounsellingReservation,
    confirmCounsellingReservation,
    getAvailabilityForMentor,
    getCounsellingPublicConfig,
    listUserBookings,
    mapCounsellingError,
    reserveCounsellingSlot,
} from './service';

function reportCounsellingError(route: string, error: unknown): void {
    const mapped = mapCounsellingError(error);
    if (mapped.status >= 500) {
        console.error(`[counselling] ${route} error:`, error);
        captureServerError(error, { tags: { feature: 'counselling', route } });
    }
}

type VerifyToken = (req: Request, res: Response, next: () => void) => Promise<void | Response>;

type AuthedRequest = Request & {
    user: { uid: string; email?: string | null; email_verified?: boolean };
};

function bookerFromRequest(req: Request): {
    uid: string;
    email: string | null;
    emailVerified: boolean | undefined;
} {
    const user = (req as AuthedRequest).user;
    return {
        uid: user.uid,
        email: user.email ?? null,
        emailVerified: user.email_verified,
    };
}

function counsellingGate(_req: Request, res: Response, next: () => void) {
    if (!isCounsellingEnabled()) {
        return res.status(503).json({
            error: 'COUNSELLING_DISABLED',
            message: 'Career counselling is not available right now.',
        });
    }
    next();
}

async function resolveIsPremium(uid: string): Promise<boolean> {
    const subscription = await refreshSubscriptionIfExpired(uid);
    return isPremiumActive(subscription);
}

export function createCounsellingRouter(
    verifyToken: VerifyToken,
    resumeSupabase: SupabaseClient
): Router {
    const router = Router();

    router.use(counsellingGate);

    router.get('/config', verifyToken, async (_req: Request, res: Response) => {
        try {
            return res.status(200).json(await getCounsellingPublicConfig());
        } catch (error) {
            console.error('[counselling] config error:', error);
            return res.status(500).json({ error: 'CONFIG_FAILED', message: 'Could not load counselling config.' });
        }
    });

    router.get('/availability', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as AuthedRequest).user.uid;
            const parsed = availabilityQuerySchema.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_QUERY',
                    message: 'Invalid query parameters',
                    details: parsed.error.flatten(),
                });
            }

            const { mentorId, durationMinutes } = parsed.data;
            const result = await getAvailabilityForMentor(resumeSupabase, mentorId, durationMinutes, uid);
            return res.status(200).json(result);
        } catch (error) {
            reportCounsellingError('availability', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/checkout', verifyToken, counsellingBookingLimiter, async (req: Request, res: Response) => {
        try {
            const booker = bookerFromRequest(req);
            const parsed = counsellingCheckoutBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            const { reservationId, goal, attendeeTimeZone } = parsed.data;
            const result = await createCounsellingCheckoutSession(resumeSupabase, {
                ...booker,
                reservationId,
                goal,
                attendeeTimeZone,
            });

            return res.status(200).json(result);
        } catch (error) {
            reportCounsellingError('checkout', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/confirm-payment', verifyToken, counsellingBookingLimiter, async (req: Request, res: Response) => {
        try {
            const uid = (req as AuthedRequest).user.uid;
            const parsed = confirmPaymentBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            const result = await syncCounsellingPaymentFromCheckoutSession(
                resumeSupabase,
                uid,
                parsed.data.sessionId
            );

            return res.status(200).json(result);
        } catch (error) {
            reportCounsellingError('confirm-payment', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/reserve', verifyToken, counsellingBookingLimiter, async (req: Request, res: Response) => {
        try {
            const booker = bookerFromRequest(req);
            const parsed = reserveSlotBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            const { mentorId, durationMinutes, slotStartsAt } = parsed.data;
            const result = await reserveCounsellingSlot(resumeSupabase, {
                ...booker,
                mentorId,
                durationMinutes,
                slotStartsAt,
            });

            return res.status(201).json(result);
        } catch (error) {
            reportCounsellingError('reserve', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/confirm', verifyToken, counsellingBookingLimiter, async (req: Request, res: Response) => {
        try {
            const booker = bookerFromRequest(req);
            const parsed = confirmReservationBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            const { reservationId, goal, attendeeTimeZone } = parsed.data;
            const result = await confirmCounsellingReservation(resumeSupabase, {
                ...booker,
                reservationId,
                goal,
                attendeeTimeZone,
            });

            return res.status(200).json(result);
        } catch (error) {
            reportCounsellingError('confirm', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/reserve/cancel', verifyToken, async (req: Request, res: Response) => {
        try {
            const booker = bookerFromRequest(req);
            const parsed = cancelReservationBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            await cancelCounsellingReservation(resumeSupabase, booker.uid, parsed.data.reservationId);
            return res.status(204).send();
        } catch (error) {
            reportCounsellingError('cancel-reservation', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.post('/book', verifyToken, counsellingBookingLimiter, async (req: Request, res: Response) => {
        try {
            const booker = bookerFromRequest(req);
            const parsed = bookSessionBodySchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_BODY',
                    message: 'Invalid request body',
                    details: parsed.error.flatten(),
                });
            }

            const { mentorId, durationMinutes, slotStartsAt, goal } = parsed.data;
            const result = await bookSessionWithoutPayment(resumeSupabase, {
                ...booker,
                mentorId,
                durationMinutes,
                slotStartsAt,
                goal,
            });

            return res.status(201).json(result);
        } catch (error) {
            reportCounsellingError('book', error);
            const mapped = mapCounsellingError(error);
            return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        }
    });

    router.get('/bookings', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as AuthedRequest).user.uid;
            const bookings = await listUserBookings(resumeSupabase, uid);
            return res.status(200).json({ bookings });
        } catch (error) {
            console.error('[counselling] list bookings error:', error);
            captureServerError(error, { tags: { feature: 'counselling', route: 'bookings' } });
            return res.status(500).json({ error: 'LIST_FAILED', message: 'Could not load your sessions.' });
        }
    });

    return router;
}
