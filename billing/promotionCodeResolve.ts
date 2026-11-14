import { getStripe } from './stripeClient';

const MAX_CODE_LENGTH = 64;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

function normalizePromotionCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const code = raw.trim();
    if (!code || code.length > MAX_CODE_LENGTH || !CODE_PATTERN.test(code)) {
        return null;
    }
    return code;
}

export type PromoCouponDuration = 'once' | 'repeating' | 'forever';

export interface ResolvedPromotionCode {
    promotionCodeId: string;
    code: string;
    /** How long the discount applies once redeemed — read straight from Stripe's own Coupon
     * object, never assumed, so UI copy about future billing can be accurate for any coupon
     * config (including ones created after this code was written). */
    duration: PromoCouponDuration;
    /** Only set when duration === 'repeating'. */
    durationInMonths: number | null;
}

/**
 * Resolve a customer-facing promotion code string to a Stripe promotion_code ID, along with
 * the underlying coupon's duration so callers can describe future billing accurately.
 * Returns null when missing, inactive, or not found — never throws for invalid codes.
 */
export async function resolveActivePromotionCodeId(
    rawCode: unknown
): Promise<ResolvedPromotionCode | null> {
    const code = normalizePromotionCode(rawCode);
    if (!code) return null;

    try {
        const list = await getStripe().promotionCodes.list({
            code,
            active: true,
            limit: 1,
            expand: ['data.promotion.coupon'],
        });
        const match = list.data[0];
        if (!match?.id || !match.active) return null;

        const coupon = match.promotion?.coupon;
        const resolvedCoupon = typeof coupon === 'object' && coupon !== null ? coupon : null;
        const duration: PromoCouponDuration = resolvedCoupon?.duration ?? 'once';
        const durationInMonths = duration === 'repeating' ? resolvedCoupon?.duration_in_months ?? null : null;

        return {
            promotionCodeId: match.id,
            code: match.code || code,
            duration,
            durationInMonths,
        };
    } catch (error) {
        console.warn('[billing] promotion code resolve failed:', error);
        return null;
    }
}
