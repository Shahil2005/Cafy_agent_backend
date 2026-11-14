import {
    getFreeAutofillLifetimeLimit,
    getPremiumAutofillDailyLimit,
    getFreeCommLimit,
    getFreeExtensionAnalysisLimit,
    isJobsWeeklyEnabled,
    isPartTimeWeeklyEnabled,
} from './config';
import { getResumeToolLimits, type ResumeToolTier } from './resumeToolConfig';

export type CatalogPlanId =
    | 'free'
    | 'premium_part_time_weekly'
    | 'premium_weekly'
    | 'premium_jobs_monthly'
    | 'premium_monthly'
    | 'premium_quarterly';

export interface PlanCatalogPlan {
    id: CatalogPlanId;
    cafyFeatures: string[];
    resumeFeatures: string[];
    /** Stripe Price ID — null for free tier */
    priceId: string | null;
    /** Formatted amount from Stripe, e.g. "£25" */
    priceDisplay: string;
    /** Billing interval label, e.g. "/month" */
    pricePeriod: string;
    /** Days between renewal charges (calendar-aware for monthly/quarterly). */
    billingPeriodDays?: number | null;
    /** Per-day price, e.g. "£0.81/day". */
    pricePerDayDisplay?: string | null;
    /** Amount in minor units (pence) for client-side per-day recalculation. */
    unitAmountMinor?: number | null;
    /** First billing period start if subscribing now (ISO). */
    renewalPeriodStart?: string | null;
    /** First renewal date if subscribing now (ISO). */
    renewalPeriodEnd?: string | null;
}

function formatCount(n: number | null, singular: string, plural?: string): string {
    if (n === null) return 'Unlimited';
    const word = n === 1 ? singular : plural ?? `${singular}s`;
    return `${n} ${word}`;
}

function buildFreeCafyFeatures(): string[] {
    const comm = getFreeCommLimit();
    const extAnalyses = getFreeExtensionAnalysisLimit();
    const autofills = getFreeAutofillLifetimeLimit();
    return [
        'Unlimited job tracker',
        'Limited job analysis access',
        `${comm} cover letters & emails`,
        `${extAnalyses} extension uses`,
        formatCount(autofills, 'Autofill credit'),
        '1 Career Path roadmap',
    ];
}

function buildCafyFeatures(tier: CatalogPlanId): string[] {
    const premiumBase = [
        'Unlimited job tracker',
        'Full jobs board',
        'Unlimited cover letters & emails',
        'Unlimited AI analysis',
        `${getPremiumAutofillDailyLimit()} Autofill credits per day`,
        'Daily Career Path roadmaps',
        'LinkedIn Optimiser',
    ];

    if (tier === 'free') {
        return buildFreeCafyFeatures();
    }

    if (tier === 'premium_part_time_weekly') {
        return ['Everything in Free, plus', 'Full UK part-time jobs'];
    }

    if (tier === 'premium_weekly' || tier === 'premium_jobs_monthly') {
        return ['Everything in Free, plus', 'Access to Unlimited jobs', 'Full UK part-time jobs'];
    }

    if (tier === 'premium_monthly' || tier === 'premium_quarterly') {
        return premiumBase;
    }

    return premiumBase;
}

function buildResumeFeatures(tier: ResumeToolTier | 'free'): string[] {
    const resumeTier: ResumeToolTier =
        tier === 'premium_monthly' || tier === 'premium_quarterly' ? tier : 'free';
    const limits = getResumeToolLimits(resumeTier);
    const editing = 'Unlimited editing';
    const premiumBase = [
        'Unlimited AI tools',
        'Unlimited imports',
        'Unlimited PDF downloads',
        editing,
    ];

    if (resumeTier === 'premium_quarterly' || resumeTier === 'premium_monthly') {
        if (limits.ai === null && limits.import === null && limits.pdfDownload === null) {
            return premiumBase;
        }
        if (resumeTier === 'premium_monthly') {
            const ai = formatCount(limits.ai, 'AI use', 'AI uses');
            const imports = formatCount(limits.import, 'import', 'imports');
            const pdf =
                limits.pdfDownload === null
                    ? 'Unlimited PDF downloads'
                    : `${limits.pdfDownload} PDF downloads per period`;
            return [`${ai} per period`, `${imports} per period`, pdf, editing];
        }
    }

    const ai = formatCount(limits.ai, 'AI use', 'AI uses');
    const imports = formatCount(limits.import, 'import', 'imports');
    const pdf =
        limits.pdfDownload === null
            ? 'Unlimited PDF downloads'
            : `${limits.pdfDownload} PDF downloads`;

    return [`${ai}`, `${imports}`, pdf, editing];
}

export async function buildPlanCatalogResponse(): Promise<{ plans: PlanCatalogPlan[] }> {
    const { getStripePlanPrices } = await import('./planPricing');
    const stripePrices = await getStripePlanPrices();
    const tiers: CatalogPlanId[] = ['free', 'premium_monthly', 'premium_quarterly'];
    if (isJobsWeeklyEnabled()) {
        if (stripePrices.jobsMonthly) {
            tiers.splice(1, 0, 'premium_jobs_monthly');
        }
        if (stripePrices.weekly) {
            tiers.splice(1, 0, 'premium_weekly');
        }
    }
    if (isPartTimeWeeklyEnabled() && stripePrices.partTimeWeekly) {
        tiers.splice(1, 0, 'premium_part_time_weekly');
    }

    return {
        plans: tiers.map((id) => {
            const stripePrice =
                id === 'premium_monthly'
                    ? stripePrices.monthly
                    : id === 'premium_quarterly'
                      ? stripePrices.quarterly
                      : id === 'premium_weekly'
                        ? stripePrices.weekly
                        : id === 'premium_jobs_monthly'
                          ? stripePrices.jobsMonthly
                          : id === 'premium_part_time_weekly'
                            ? stripePrices.partTimeWeekly
                            : null;

            const resumeTier: ResumeToolTier | 'free' =
                id === 'premium_monthly' || id === 'premium_quarterly' ? id : 'free';

            return {
                id,
                cafyFeatures: buildCafyFeatures(id),
                resumeFeatures: buildResumeFeatures(resumeTier),
                priceId: stripePrice?.priceId ?? null,
                priceDisplay: id === 'free' ? '£0' : stripePrice?.priceDisplay ?? '—',
                pricePeriod: id === 'free' ? '' : stripePrice?.pricePeriod ?? '',
                billingPeriodDays: id === 'free' ? null : stripePrice?.billingPeriodDays ?? null,
                pricePerDayDisplay: id === 'free' ? '£0/day' : stripePrice?.pricePerDayDisplay ?? null,
                unitAmountMinor: id === 'free' ? null : stripePrice?.unitAmountMinor ?? null,
                renewalPeriodStart: id === 'free' ? null : stripePrice?.renewalPeriodStart ?? null,
                renewalPeriodEnd: id === 'free' ? null : stripePrice?.renewalPeriodEnd ?? null,
            };
        }),
    };
}
