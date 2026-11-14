import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createChatCatalogueReadOnlyFetch } from '../../jobs-portal/chatCatalogue';
import type { JobListCard, UiPiece } from '../contract';
import type { CvIndex } from '../cv';
import { CvTextMatcher } from '../cv/profile';
import { buildJobComparison, commonGaps, MAX_COMPARE, MIN_COMPARE } from '../jobs/compare';
import { betterPaid, isHigherLevel, MIN_PAY_SAMPLES, payRoleFromCv, payStats, yearlyPay } from '../jobs/salary';
import { createJobExplainer, jobDetailsFromDatabase, realGaps, type JobDetail, type JobSearchDeps } from '../jobs/search';
import { listAt } from './jobs';
import { defineTool, type AgentTool } from './types';

/** Advertised pay strings for open jobs whose title contains the role, newest first. Read-only. */
export type PayLoader = (role: string, location: string | undefined, signal: AbortSignal) => Promise<string[]>;

const PAY_ROWS = 400;

export const payFromDatabase: PayLoader = async (role, location, signal) => {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error('Jobs database is not configured');
    const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9 &'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: createChatCatalogueReadOnlyFetch({ signal }) } });
    let query = db.from('jobs').select('salary').ilike('title', `%${clean(role)}%`).not('salary', 'is', null);
    if (location && clean(location)) query = query.ilike('location', `%${clean(location)}%`);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(PAY_ROWS);
    if (error || !data) throw new Error('Pay data is unavailable');
    return (data as Array<{ salary?: string | null }>).flatMap((row) => (row.salary ? [row.salary] : []));
};

export interface PaidAdvert {
    id: number;
    title: string;
    salary: string;
    companyId?: number;
}

/** Open jobs whose title contains the role and that state a salary, newest first. Read-only. */
export type PaidAdvertLoader = (role: string, signal: AbortSignal) => Promise<PaidAdvert[]>;

export const paidAdvertsFromDatabase: PaidAdvertLoader = async (role, signal) => {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new Error('Jobs database is not configured');
    const clean = role.toLowerCase().replace(/[^a-z0-9 &'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: createChatCatalogueReadOnlyFetch({ signal }) } });
    const { data, error } = await db.from('jobs').select('id, title, salary, company_id').ilike('title', `%${clean}%`).not('salary', 'is', null).order('created_at', { ascending: false }).limit(PAY_ROWS);
    if (error || !data) throw new Error('Pay data is unavailable');
    return (data as Array<{ id: number | string; title?: string | null; salary?: string | null; company_id?: number | string | null }>).flatMap((row) =>
        row.title && row.salary && Number.isFinite(Number(row.id))
            ? [{ id: Number(row.id), title: row.title, salary: row.salary, ...(row.company_id != null && Number.isFinite(Number(row.company_id)) ? { companyId: Number(row.company_id) } : {}) }]
            : [],
    );
};

const gbp = (n: number) => `£${n.toLocaleString('en-GB')}`;

/** Jobs read against the CV like the job cards: only CV quotes really in the CV, and only real gaps. */
async function readAgainstCv(cv: CvIndex, ids: number[], read: { details: JobSearchDeps['details']; explain: JobSearchDeps['explain'] }, signal: AbortSignal): Promise<Array<JobListCard['items'][number]>> {
    const details = await read.details(ids, signal);
    if (!details.length) return [];
    const fits = await read.explain(cv, details, signal).catch(() => []);
    const matcher = new CvTextMatcher(cv.text);
    return details.map((job) => {
        const fit = fits.find((f) => f.id === job.id);
        return { id: job.id, title: job.title, sponsor: Boolean(job.sponsor), have: (fit?.have ?? []).filter((h) => h.quote && matcher.contains(h.quote)), missing: realGaps(fit?.missing ?? [], cv.text) };
    });
}

/** Better-paid adverts read against the CV: enough to see a pattern, few enough for one quick AI reading. */
const HIGHER_PAY_READ = 5;
/** Cards on screen that were never read against the CV are read now, up to one page. */
const GAPS_READ = 10;

export function createInsightTools(deps: { pay?: PayLoader; paidAdverts?: PaidAdvertLoader; details?: JobSearchDeps['details']; explain?: JobSearchDeps['explain'] } = {}): AgentTool[] {
    const loadPay = deps.pay ?? payFromDatabase;
    const loadPaidAdverts = deps.paidAdverts ?? paidAdvertsFromDatabase;
    let explainer: JobSearchDeps['explain'] | undefined = deps.explain;
    const reader = { details: deps.details ?? jobDetailsFromDatabase, explain: (cv: CvIndex, jobs: JobDetail[], signal: AbortSignal) => (explainer ??= createJobExplainer())(cv, jobs, signal) };

    const compareJobs = defineTool({
        name: 'compare_jobs',
        description:
            'Puts two or three jobs from the cards on screen side by side (pay, place, type, sponsor licence, visa estimate, how close each is to the CV, what is missing) and says which is closer. Use for "compare job 1 and 3", "which of these is better". positions are the card numbers. Does not search again.',
        args: z.object({ positions: z.array(z.number().int().min(1).max(50)).min(MIN_COMPARE).max(MAX_COMPARE), list: z.number().int().min(0).max(2).optional() }).strict(),
        label: (args) => `Comparing jobs ${args.positions.join(', ')}`,
        maxResultChars: 9_000,
        async run(args, ctx) {
            const list = listAt(ctx, args.list);
            const wanted = [...new Set(args.positions)];
            const items = wanted.flatMap((position) => {
                const item = list?.items[position - 1];
                return item ? [item] : [];
            });
            if (!list || items.length < MIN_COMPARE || items.length !== wanted.length) {
                return { error: 'NO_SUCH_JOBS', instruction: 'Say you cannot tell which jobs they mean, and ask them to name two or three from the cards. If no jobs are on screen, offer to search first.' };
            }
            const card = buildJobComparison(items);
            ctx.emit('job-compare', { kind: 'jobCompare', card });
            const closest = card.jobs.find((job) => job.id === card.closestId);
            return {
                jobs: card.jobs.map((job, i) => ({ position: wanted[i], title: job.title, company: job.company, location: job.location, salary: job.salary, jobType: job.jobType, verdict: job.verdict, matches: job.have, missing: job.missing, levelNote: job.levelNote })),
                closest: closest ? { title: closest.title, company: closest.company } : undefined,
                cvRead: Boolean(closest),
                instruction:
                    'The comparison card shows every fact side by side; do not repeat its figures or list the jobs again. In three or four sentences say how they differ that matters (pay if stated, level, what each needs that the CV lacks) and, only when "closest" is given, which is closer to their CV and why, using its verdict. If cvRead is false, say you compared only the adverts and offer to read them against their CV. Pay is only what the card shows. A sponsor badge means a licence, never that the job is sponsored. Never promise any job.',
            };
        },
    });

    const skillGaps = defineTool({
        name: 'skill_gaps',
        description:
            'Counts which skills the jobs on screen ask for that the selected CV does not show, most common first, and shows them as a card. Use for "what skills am I missing for these jobs", "what should I learn". Needs a job list on screen and a CV.',
        args: z.object({ list: z.number().int().min(0).max(2).optional() }).strict(),
        label: () => 'Finding the skills these jobs ask for',
        async run(args, ctx) {
            if (!ctx.cv) return { error: 'NEED_CV', instruction: 'Ask them to choose one of their saved CVs so you can see which skills their CV does not show.' };
            const list = listAt(ctx, args.list);
            if (!list?.items.length) {
                return { error: 'NO_JOBS_ON_SCREEN', instruction: 'There are no jobs on screen yet. Call search_jobs (with no role for jobs that match their CV), then call skill_gaps. Do not ask the user anything first.' };
            }
            let read = list.items.filter((job) => job.have.length || job.missing.length || job.verdict);
            // Cards shown before the CV reading finished (a slow search) are read now, so the answer never stalls.
            if (!read.length) read = await readAgainstCv(ctx.cv, list.items.slice(0, GAPS_READ).map((job) => job.id), reader, ctx.signal);
            const gaps = commonGaps(read);
            if (!gaps.length) {
                return { basedOn: read.length, gaps: [], instruction: 'Say that across these jobs nothing concrete is missing from their CV, so there is no skill to add for them. Suggest checking the full adverts and applying only where the level fits.' };
            }
            ctx.emit('skill-gaps', { kind: 'skillGaps', card: { basedOn: read.length, gaps } });
            return {
                basedOn: read.length,
                gaps,
                instruction:
                    'The card lists the skills with how many of these jobs ask for each; do not list them again. Say in two or three sentences which one or two matter most and why. Then a "steps" piece: a short learning plan for the top gaps (what to learn, a small project to show it, where the CV should mention it). Name no course provider or price. Say the counts come from only these jobs.',
            };
        },
    });

    const salaryStats = defineTool({
        name: 'salary_stats',
        description:
            'Advertised yearly pay for a role in CAFY\'s open jobs: typical (median) and the middle range, from real adverts that state a yearly pound figure. Use for "how much does a <role> earn", "is £X good for <role>", salary negotiation. role is the user\'s own words; location is optional. Returns nothing when too few adverts state their pay.',
        args: z.object({ role: z.string().trim().min(2).max(80), location: z.string().trim().min(2).max(60).optional() }).strict(),
        label: (args) => `Checking advertised pay for “${args.role.slice(0, 40)}”${args.location ? ` in ${args.location.slice(0, 30)}` : ''}`,
        async run(args, ctx) {
            let rows: string[];
            try {
                rows = await loadPay(args.role, args.location, ctx.signal);
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                return { error: 'PAY_UNAVAILABLE', instruction: 'Say the pay data could not be read this time and to try again. Give no salary figure from memory.' };
            }
            const values = rows.flatMap((salary) => {
                const pay = yearlyPay(salary);
                return pay === null ? [] : [pay];
            });
            const stats = payStats(values);
            if (!stats) {
                return {
                    error: 'NOT_ENOUGH_PAY_DATA',
                    advertsWithYearlyPay: values.length,
                    needed: MIN_PAY_SAMPLES,
                    instruction: `Say fewer than ${MIN_PAY_SAMPLES} open jobs in CAFY's catalogue state a yearly pay for this, so you cannot give a reliable figure. Give no figure from memory. Offer to show live jobs for this role and read their pay, and suggest checking the pay in each advert.`,
                };
            }
            const where = args.location ? ` in ${args.location}` : '';
            const pieces: UiPiece[] = [
                { type: 'heading', text: `Advertised pay: ${args.role}${where}` },
                {
                    type: 'facts',
                    items: [
                        { label: 'Typical (median)', value: gbp(stats.median) },
                        { label: 'Middle half of adverts', value: `${gbp(stats.lowerQuartile)} – ${gbp(stats.upperQuartile)}` },
                        { label: 'Lowest – highest', value: `${gbp(stats.lowest)} – ${gbp(stats.highest)}` },
                        { label: 'Based on', value: `${stats.samples} open jobs that state a yearly pay` },
                    ],
                },
                { type: 'warning', text: 'These are advertised salaries in CAFY\'s open jobs, not what people are paid. Pay varies with employer, place and experience.' },
            ];
            ctx.emit('salary-stats', { kind: 'answerCard', pieces });
            return {
                role: args.role,
                location: args.location,
                median: stats.median,
                lowerQuartile: stats.lowerQuartile,
                upperQuartile: stats.upperQuartile,
                lowest: stats.lowest,
                highest: stats.highest,
                samples: stats.samples,
                instruction:
                    'The card shows the figures; do not list them again. In two or three sentences say what the typical advertised pay is and the middle range, using exactly the figures given (no rounding, no other numbers), and that it comes from adverts that state a yearly pay. If they gave their own pay or an offer, say where it falls against the middle range, without telling them it is fair or unfair. For negotiation: suggest asking for the range, citing their evidence from the CV, and a polite counter. Never invent pay for a role or place not in these figures.',
            };
        },
    });

    const higherPay = defineTool({
        name: 'higher_pay',
        description:
            'For "how can I earn more", "better-paid jobs", "what should I change in my CV to get a higher salary": reads advertised pay for the role on their CV (or the role given), the better-paid adverts for it, and what those adverts ask that the CV does not show. Shows a pay card and a skills card. Needs a CV. role is optional, in the user\'s words.',
        args: z.object({ role: z.string().trim().min(2).max(80).optional() }).strict(),
        label: (args) => `Checking pay and better-paid ${args.role ? `“${args.role.slice(0, 40)}” ` : ''}jobs`,
        maxResultChars: 9_000,
        async run(args, ctx) {
            if (!ctx.cv) return { error: 'NEED_CV', instruction: 'Ask them to choose one of their saved CVs so you can compare it with better-paid jobs.' };
            const role = args.role?.toLowerCase() ?? payRoleFromCv(ctx.cv.profile);
            // From the CV, for the advice: measurable results and the skills used at work.
            const cvEvidence = {
                results: ctx.cv.profile.achievements.slice(0, 4).map((a) => a.evidence),
                skillsUsedAtWork: ctx.cv.profile.skills.filter((s) => s.source === 'experience').slice(0, 10).map((s) => s.name),
            };
            const advice =
                'Then a "steps" piece with CV changes for better-paid jobs, from their CV only: lead each role with measurable results (quote pieces copied exactly from cvEvidence.results), put the skills better-paid adverts ask for that they already have near the top, add a missing skill only once they have used it, and use the wording of better-paid job titles only where it is true. Never promise a salary or a job.';
            if (!role) return { error: 'NO_ROLE', cvEvidence, instruction: `Their CV shows no job title to compare pay for. Give the CV advice without any figure. ${advice}` };
            let adverts: PaidAdvert[];
            try {
                adverts = await loadPaidAdverts(role, ctx.signal);
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                return { error: 'PAY_UNAVAILABLE', role, cvEvidence, instruction: `Say the pay data could not be read this time. Give no figure from memory. ${advice}` };
            }
            const payOf = (a: PaidAdvert) => yearlyPay(a.salary);
            const priced = adverts.filter((a) => payOf(a) !== null);
            // Typical pay is what adverts at their own level pay; senior, lead and manager adverts are the step up.
            const sameLevel = priced.filter((a) => !isHigherLevel(a.title));
            const stats = payStats(sameLevel.map((a) => payOf(a)!));
            const above = stats ? priced.filter((a) => isHigherLevel(a.title) || payOf(a)! >= stats.upperQuartile) : priced.filter((a) => isHigherLevel(a.title));
            const groups = betterPaid(above, { upperQuartile: stats?.upperQuartile ?? 0 });
            if (!stats && !groups.length) {
                return {
                    error: 'NOT_ENOUGH_PAY_DATA',
                    role,
                    cvEvidence,
                    instruction: `Fewer than ${MIN_PAY_SAMPLES} open ${role} jobs in CAFY state a yearly pay, so give no figure. Still answer fully: ${advice} Offer to show live ${role} jobs.`,
                };
            }
            const employers = new Set((stats ? sameLevel : above).map((a) => a.companyId ?? `job-${a.id}`)).size;
            const ids = groups.flatMap((g) => g.ids.slice(0, 1)).concat(groups.flatMap((g) => g.ids.slice(1))).slice(0, HIGHER_PAY_READ);
            const read = ids.length ? await readAgainstCv(ctx.cv, ids, reader, ctx.signal) : [];
            const gaps = commonGaps(read);
            const strengths = [...new Set(read.flatMap((job) => job.have.map((h) => h.skill)))].slice(0, 6);
            const pieces: UiPiece[] = [
                { type: 'heading', text: `Pay for ${role} jobs in CAFY` },
                ...(stats
                    ? [{
                          type: 'facts' as const,
                          items: [
                              { label: 'Typical at your level', value: gbp(stats.median) },
                              { label: 'Middle half of adverts', value: `${gbp(stats.lowerQuartile)} – ${gbp(stats.upperQuartile)}` },
                              { label: 'Based on', value: `${stats.samples} adverts from ${employers} employer${employers === 1 ? '' : 's'} that state a yearly pay` },
                          ],
                      }]
                    : [{ type: 'paragraph' as const, text: `Too few ${role} adverts at your level state a yearly pay to give a typical figure.` }]),
                ...(groups.length ? [{ type: 'list' as const, title: 'Better-paid adverts right now', items: groups.map((g) => ({ title: g.title, text: `Typical ${gbp(g.typicalPay)} · ${g.adverts} advert${g.adverts === 1 ? '' : 's'}` })) }] : []),
                { type: 'warning', text: 'Advertised salaries in CAFY\'s open jobs, not what people are paid. Pay also depends on employer, place and experience.' },
            ];
            ctx.emit('higher-pay', { kind: 'answerCard', pieces });
            if (gaps.length) ctx.emit('skill-gaps', { kind: 'skillGaps', card: { basedOn: read.length, gaps } });
            return {
                role,
                ...(stats ? { median: stats.median, lowerQuartile: stats.lowerQuartile, upperQuartile: stats.upperQuartile, samples: stats.samples, employers } : {}),
                betterPaid: groups.map((g) => ({ title: g.title, typicalPay: g.typicalPay, adverts: g.adverts })),
                gaps,
                strengthsTheyAskFor: strengths,
                readAdverts: read.length,
                cvEvidence,
                instruction: `Answer their question directly; do not ask what roles they want. The cards show the figures and the skills; do not list them again. In three or four sentences: ${stats ? `where typical ${role} pay at their level sits` : `that there is no typical figure at their level (too few adverts), so no typical figure`} and what the better-paid adverts are (titles and figures exactly as given, no other numbers; they are mostly more senior, so say that the step up is in level and skills), which one or two skills from gaps those adverts ask for most, and which of their strengths those adverts also want. ${advice}`,
            };
        },
    });

    return [compareJobs, skillGaps, salaryStats, higherPay];
}

export const INSIGHT_TOOLS: AgentTool[] = createInsightTools();
