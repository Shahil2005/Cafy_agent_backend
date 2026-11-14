import type { JobCompareCard, JobListCard } from '../contract';
import { bestFirst } from './search';

type Item = JobListCard['items'][number];

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 3;

/**
 * Side-by-side facts for two or three listed jobs, built by code from the cards already shown.
 * `closestId` is only set when the CV was read against every job: it follows the same verdict order as the shortlist.
 */
export function buildJobComparison(items: Item[]): JobCompareCard {
    const jobs = items.slice(0, MAX_COMPARE).map((job) => ({
        id: job.id,
        title: job.title,
        ...(job.company ? { company: job.company } : {}),
        ...(job.location ? { location: job.location } : {}),
        ...(job.salary ? { salary: job.salary } : {}),
        ...(job.jobType ? { jobType: job.jobType } : {}),
        ...(job.postedAt ? { postedAt: job.postedAt } : {}),
        ...(job.url ? { url: job.url } : {}),
        sponsorLicence: job.sponsor,
        ...(job.levelNote ? { levelNote: job.levelNote } : {}),
        ...(job.verdict ? { verdict: job.verdict } : {}),
        ...(job.visa ? { visa: { outcome: job.visa.outcome, soc: job.visa.soc.code, sure: job.visa.soc.sure, ...(job.visa.payCheck ? { payCheck: job.visa.payCheck } : {}) } } : {}),
        have: job.have.map((h) => h.skill),
        missing: job.missing,
    }));
    const allRead = jobs.length > 1 && jobs.every((job) => job.verdict);
    const closest = allRead ? bestFirst(items.slice(0, MAX_COMPARE))[0] : undefined;
    return { jobs, ...(closest ? { closestId: closest.id } : {}) };
}

/** Skills the CV does not show, counted across jobs: what employers keep asking for. Most common first. */
export function commonGaps(items: Item[], limit = 8): Array<{ skill: string; jobs: number }> {
    const counts = new Map<string, { skill: string; jobs: number }>();
    for (const job of items) {
        const seen = new Set<string>();
        for (const gap of job.missing) {
            const key = gap.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const entry = counts.get(key);
            if (entry) entry.jobs += 1;
            else counts.set(key, { skill: gap, jobs: 1 });
        }
    }
    return [...counts.values()].sort((a, b) => b.jobs - a.jobs || a.skill.localeCompare(b.skill)).slice(0, limit);
}
