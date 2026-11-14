/** Explicit public evidence allowlist; never pass worker output or model notes directly to clients. */
export interface PublicSponsorshipAssessment {
    verdict: 'advert_supported' | 'potential';
    assessedAt: string;
    expiresAt: string;
    scenario: 'standard_skilled_worker';
    occupation: { code: string; title: string; status: 'estimated' };
    employer: { organisation: string; checkedAt: string; sourceUrl: string };
    salary: {
        requiredAnnual: number;
        advertisedMin: number;
        advertisedMax: number;
        weeklyHours: number;
    };
    sponsorshipPolicy: 'positive' | 'unknown';
    sponsorshipEvidence: string[];
    sources: string[];
}
const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
const string = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : '');
const number = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
function officialUrl(v: unknown): string | null {
    try {
        const u = new URL(String(v));
        return u.protocol === 'https:' && u.hostname === 'www.gov.uk'
            ? u.toString()
            : null;
    } catch {
        return null;
    }
}
export function publicSponsorshipAssessment(
    value: unknown,
): PublicSponsorshipAssessment | undefined {
    const r = object(value),
        occupation = object(r.occupation),
        licence = object(r.licence ?? r.employer);
    const salary = object(r.salary);
    const pay = r.salaryEvidence
        ? object(r.salaryEvidence)
        : { min: salary.advertisedMin, max: salary.advertisedMax };
    const hours = r.hoursEvidence
        ? object(r.hoursEvidence)
        : { value: salary.weeklyHours };
    const assessedAt = string(r.assessedAt),
        expiresAt = string(r.expiresAt);
    if (
        !['advert_supported', 'potential'].includes(String(r.verdict)) ||
        !/^\d{4}$/.test(string(occupation.code)) ||
        !(Date.parse(expiresAt) > Date.now()) ||
        !Number.isFinite(Date.parse(assessedAt)) ||
        r.scenario !== 'standard_skilled_worker' ||
        !['positive', 'unknown'].includes(String(r.sponsorshipPolicy)) ||
        !number(salary.requiredAnnual) ||
        !number(pay.min) ||
        !number(hours.value)
    )
        return undefined;
    return {
        verdict: r.verdict as PublicSponsorshipAssessment['verdict'],
        assessedAt,
        expiresAt,
        scenario: 'standard_skilled_worker',
        occupation: {
            code: string(occupation.code),
            title: string(occupation.title),
            status: 'estimated',
        },
        employer: {
            organisation: string(licence.organisation),
            checkedAt: string(licence.checkedAt),
            sourceUrl: officialUrl(licence.sourceUrl) || '',
        },
        salary: {
            requiredAnnual: number(salary.requiredAnnual),
            advertisedMin: number(pay.min),
            advertisedMax: number(pay.max),
            weeklyHours: number(hours.value),
        },
        sponsorshipPolicy: r.sponsorshipPolicy as 'positive' | 'unknown',
        sponsorshipEvidence: Array.isArray(r.sponsorshipEvidence)
            ? r.sponsorshipEvidence
                  .filter((e): e is string => typeof e === 'string')
                  .slice(0, 5)
                  .map((e) => e.slice(0, 2000))
            : [],
        sources: Array.isArray(r.sources)
            ? r.sources.map(officialUrl).filter((u): u is string => !!u)
            : [],
    };
}
