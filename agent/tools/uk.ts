import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { callEmbedMatch } from '../../ai/careerAnalysis/vectorSearch';
import type { OfficialFactsCard, SocCardsCard } from '../contract';
import { createSocChooser, type SocChooser } from './socChoice';
import type { CvIndex } from '../cv';
import { defineTool, type AgentTool } from './types';

/**
 * UK facts come from CAFY's own SOC 2020 dataset (ONS SOC + Appendix Skilled Worker going rates),
 * never from model memory. Salary thresholds are worked out by code. No AI tokens are used here.
 */

interface RateEntry { annual: number; hourly?: number; pointsOptions?: string[] }
interface RateTable { rate100?: RateEntry; rate90?: RateEntry; rate80?: RateEntry; rate70?: RateEntry; source?: string }
interface Occupation {
    code: string;
    title: string;
    category?: string;
    relatedJobTitles?: string[];
    skillLevel?: string | null;
    sponsorship?: {
        skilledWorkerEligible?: boolean;
        immigrationSalaryList?: Array<{ criteria?: string; removalDate?: string; nations?: Record<string, boolean> }> | null;
        applicantStatus?: string;
        phdEligible?: boolean | null;
        routes?: { skilledWorker?: boolean; globalBusinessMobility?: boolean; scaleUp?: boolean } | null;
    } | null;
    salary?: { median?: RateTable | null; percentile25?: RateTable | null; nationalPayScale?: { byNation?: Record<string, { rawText?: string }> } | null } | null;
    expandedJobTitles?: string[];
}
interface PointsOption { floorSalary: number; goingRatePercent: number; appliesTo: string; condition: string }
interface SocDataset {
    generatedAt: string;
    visaSalaryRules: { document: string; url: string; note: string; pointsOptions: Record<string, PointsOption> };
    occupations: Occupation[];
}

let cache: { data: SocDataset; byCode: Map<string, Occupation> } | null = null;

export function socDataset(): { data: SocDataset; byCode: Map<string, Occupation> } {
    if (cache) return cache;
    const file = path.join(__dirname, '..', '..', 'data', 'uk_soc_master.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as SocDataset;
    cache = { data, byCode: new Map(data.occupations.map((o) => [o.code, o])) };
    return cache;
}

interface ShortageList {
    url: string;
    certificateIssuedBefore: string;
    entries: Array<{ code: string; title: string; onlyJobTypes?: string[] }>;
}

let shortageCache: ShortageList | null = null;

/** Official Temporary Shortage List (Appendix Skilled Worker SW 6.1A). Gone once its date has passed. */
function shortageEntry(code: string, now: number): ShortageList['entries'][number] | null {
    shortageCache ??= JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'data', 'uk_temporary_shortage_list.json'), 'utf8')) as ShortageList;
    if (now >= Date.parse(shortageCache.certificateIssuedBefore)) return null;
    return shortageCache.entries.find((entry) => entry.code === code) ?? null;
}

/** Immigration Salary List entries still in force: a job leaves the list on its official removal date. */
function activeSalaryList(occupation: Occupation, now: number) {
    return (occupation.sponsorship?.immigrationSalaryList ?? []).filter((entry) => !entry.removalDate || Date.parse(`${entry.removalDate} UTC`) > now);
}

/** Care worker codes: official rule SW 6.1B allows only applications to stay, whatever the lists say. */
function isRestrictedCareCode(occupation: Occupation): boolean {
    return (occupation.sponsorship?.immigrationSalaryList ?? []).some((entry) => /SW 6\.1B/.test(entry.criteria ?? ''));
}

/** Official Table 2a codes: also in Table 6 (not eligible), kept only for people granted permission before 4 April 2024. */
function isPre2024Only(occupation: Occupation): boolean {
    return /^Table 2a\b/.test(occupation.salary?.percentile25?.source ?? '');
}

function dataDate(generatedAt: string): string {
    const d = new Date(generatedAt);
    return Number.isNaN(d.getTime()) ? generatedAt : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function rateFor(occupation: Occupation, option: string): RateEntry | undefined {
    for (const table of [occupation.salary?.median, occupation.salary?.percentile25]) {
        if (!table) continue;
        for (const rate of [table.rate100, table.rate90, table.rate80, table.rate70]) {
            if (rate?.pointsOptions?.includes(option)) return rate;
        }
    }
    return undefined;
}

export interface SocThreshold {
    option: string;
    condition: string;
    floorSalary: number;
    goingRatePercent: number;
    goingRate: number;
    hourly?: number;
    /** The salary a sponsor must pay: whichever is higher, the floor or the going-rate percentage. */
    threshold: number;
}

/** Every points option that applies to this occupation, with its threshold worked out by code. */
export function socThresholds(code: string): SocThreshold[] {
    const { data, byCode } = socDataset();
    const occupation = byCode.get(code);
    if (!occupation) return [];
    const onSalaryList = activeSalaryList(occupation, Date.now()).length > 0;
    return Object.entries(data.visaSalaryRules.pointsOptions).flatMap(([option, rule]) => {
        const rate = rateFor(occupation, option);
        // Options D and I only exist for jobs on the Immigration Salary List.
        // No figure in the official table means "Not applicable", so the option does not exist for this code.
        if (!rate?.annual || ((option === 'D' || option === 'I') && !onSalaryList)) return [];
        return [{
            option,
            condition: rule.condition,
            floorSalary: rule.floorSalary,
            goingRatePercent: rule.goingRatePercent,
            goingRate: rate.annual,
            hourly: rate.hourly,
            threshold: Math.max(rule.floorSalary, rate.annual),
        }];
    });
}

function eligibility(occupation: Occupation, now = Date.now()): { eligible: boolean | null; note: string } {
    const status = occupation.sponsorship?.applicantStatus;
    if (status === 'not_eligible') return { eligible: false, note: 'Not eligible for the Skilled Worker route.' };
    if (status === 'open_to_new_applicants') {
        return { eligible: true, note: /RQF6/.test(occupation.skillLevel ?? '') ? 'Higher-skilled occupation: eligible for the Skilled Worker route.' : 'Open to new applicants on the Skilled Worker route.' };
    }
    if (status !== 'legacy_only_existing_visa_holders') return { eligible: null, note: 'Check the eligible occupations list on GOV.UK.' };
    if (isRestrictedCareCode(occupation)) {
        return { eligible: null, note: 'Restricted by GOV.UK rule SW 6.1B: only applications to stay in the UK, by people already working for the sponsor in a care code or already sponsored in one.' };
    }
    if (isPre2024Only(occupation)) {
        return { eligible: false, note: 'Not eligible for new applicants (GOV.UK Table 6): only for people granted Skilled Worker permission before 4 April 2024 with continuous permission since. The figures below may not apply to you.' };
    }
    const lists = [
        ...(activeSalaryList(occupation, now).length ? ['the Immigration Salary List'] : []),
        ...(shortageEntry(occupation.code, now) ? ['the Temporary Shortage List'] : []),
    ];
    if (lists.length) return { eligible: true, note: `Open to new applicants only through ${lists.join(' or ')}: check the conditions and dates.` };
    return { eligible: false, note: 'Medium-skilled occupation: only for people granted Skilled Worker permission before 22 July 2025 with continuous permission since. A new applicant cannot normally be sponsored in it, so the figures below may not apply to you.' };
}

const gbp = (n: number) => `£${n.toLocaleString('en-GB')}`;

/** Who can use a code, in plain words, from the official applicant status. */
export function socApplicantRules(code: string, now = Date.now()): { newApplicants: string; existingHolders: string } {
    const occupation = socDataset().byCode.get(code);
    const status = occupation?.sponsorship?.applicantStatus;
    if (status === 'open_to_new_applicants') return { newApplicants: 'Open to new applicants', existingHolders: 'Open to existing Skilled Worker visa holders' };
    if (occupation && status === 'legacy_only_existing_visa_holders') {
        if (isRestrictedCareCode(occupation)) {
            return {
                newApplicants: 'Only for applications to stay in the UK, after at least 3 months legally working for the sponsor in a care code, with the application made before 22 July 2028',
                existingHolders: 'Open if you already have Skilled Worker permission sponsored in a care worker or senior care worker code',
            };
        }
        if (isPre2024Only(occupation)) {
            return {
                newApplicants: 'Not open to new applicants',
                existingHolders: 'Open if you were granted Skilled Worker permission before 4 April 2024, with continuous permission since',
            };
        }
        const shortage = shortageEntry(code, now);
        const routes = [
            ...(shortage ? [`Open through the Temporary Shortage List, if the sponsor issues your certificate of sponsorship before 31 December 2026${shortage.onlyJobTypes ? `, only for: ${shortage.onlyJobTypes.join('; ')}` : ''}`] : []),
            ...activeSalaryList(occupation, now).slice(0, 1).map((entry) => `Open through the Immigration Salary List, if the job meets its criteria and the sponsor issues your certificate of sponsorship before ${entry.removalDate}`),
        ];
        return {
            newApplicants: routes.length ? routes.join('. ') : 'Not normally open to new applicants',
            existingHolders: 'Open if you were granted Skilled Worker permission before 22 July 2025, with continuous permission since',
        };
    }
    if (status === 'not_eligible') return { newApplicants: 'Not eligible', existingHolders: 'Not eligible' };
    return { newApplicants: 'Check GOV.UK', existingHolders: 'Check GOV.UK' };
}

/** Most occupations have far fewer; a few official lists run past 1,000 titles. */
const MAX_JOB_TITLES = 150;

/** What a user needs to understand one code, beyond the salary options. Fields with nothing to say are left out. */
export function socDetails(code: string): OfficialFactsCard['details'] {
    const occupation = socDataset().byCode.get(code);
    if (!occupation) return undefined;
    const titles = [...new Set([...(occupation.relatedJobTitles ?? []), ...(occupation.expandedJobTitles ?? [])].map((t) => t.trim()).filter(Boolean))];
    const sponsorship = occupation.sponsorship;
    const routes = sponsorship?.routes;
    // Official Table 2aa: "not eligible for the Global Business Mobility or Scale-up routes". Table 2a is for Skilled Worker applicants only.
    const legacyTable = /2aa/.test(occupation.salary?.percentile25?.source ?? '') || isPre2024Only(occupation);
    const salaryList = activeSalaryList(occupation, Date.now());
    const table = [occupation.salary?.median?.source, occupation.salary?.percentile25?.source].filter(Boolean).join('; ');
    return {
        jobTitles: titles.slice(0, MAX_JOB_TITLES),
        moreJobTitles: Math.max(0, titles.length - MAX_JOB_TITLES),
        ...(typeof sponsorship?.phdEligible === 'boolean' ? { phdEligible: sponsorship.phdEligible } : {}),
        ...(routes
            ? {
                  routes: [
                      ...(routes.skilledWorker ? ['Skilled Worker'] : []),
                      ...(routes.globalBusinessMobility && !legacyTable ? ['Global Business Mobility'] : []),
                      ...(routes.scaleUp && !legacyTable ? ['Scale-up'] : []),
                  ],
              }
            : {}),
        ...(salaryList.length
            ? {
                  salaryList: salaryList.map((entry) => ({
                      criteria: entry.criteria ?? '',
                      ...(entry.nations ? { where: Object.entries(entry.nations).filter(([, on]) => on).map(([nation]) => nation).join(', ') } : {}),
                      ...(entry.removalDate ? { until: entry.removalDate } : {}),
                  })),
              }
            : {}),
        ...(occupation.salary?.nationalPayScale?.byNation
            ? {
                  payScales: Object.entries(occupation.salary.nationalPayScale.byNation).flatMap(([nation, scale]) =>
                      scale.rawText ? [{ nation, text: scale.rawText.replace(/\|+/g, '\n').trim() }] : [],
                  ),
              }
            : {}),
        ...(table ? { table } : {}),
    };
}

export function socSummary(code: string) {
    const { byCode } = socDataset();
    const occupation = byCode.get(code);
    if (!occupation) return null;
    const thresholds = socThresholds(code);
    const general = thresholds.find((t) => t.option === 'A') ?? thresholds.find((t) => t.option === 'F');
    const newEntrant = thresholds.find((t) => t.option === 'E') ?? thresholds.find((t) => t.option === 'J');
    return {
        code,
        title: occupation.title,
        category: occupation.category,
        // GOV.UK states no skill level for Table 2a codes; the label in the data file is not official.
        skillLevel: isPre2024Only(occupation) ? null : occupation.skillLevel?.replace(/\s*\(legacy rule\)/i, '') ?? null,
        ...eligibility(occupation),
        exampleJobTitles: (occupation.relatedJobTitles ?? []).slice(0, 4),
        generalThreshold: general?.threshold,
        newEntrantThreshold: newEntrant?.threshold,
        thresholds,
    };
}

function normaliseTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

let titleIndex: Map<string, Set<string>> | null = null;

/** Occupations whose official job-title list contains the given title (e.g. "software engineer" → 2134). */
export function officialTitleMatches(query: string): string[] {
    if (!titleIndex) {
        titleIndex = new Map();
        for (const o of socDataset().data.occupations) {
            const titles = [o.title, ...(o.relatedJobTitles ?? []), ...((o as { expandedJobTitles?: string[] }).expandedJobTitles ?? [])];
            for (const t of titles) {
                const key = normaliseTitle(t);
                if (!key) continue;
                if (!titleIndex.has(key)) titleIndex.set(key, new Set());
                titleIndex.get(key)!.add(o.code);
            }
        }
    }
    const q = normaliseTitle(query);
    const singular = q.replace(/s$/, '');
    return [...new Set([...(titleIndex.get(q) ?? []), ...(titleIndex.get(singular) ?? []), ...(titleIndex.get(`${singular}s`) ?? [])])];
}

/** Below this similarity (percent), a SOC suggestion without an official title match is flagged as weak. */
const LOW_CONFIDENCE_MATCH = 78;

export type SocMatcher = (chunks: string[]) => Promise<Array<{ soc_code: string; similarity: number }>>;

/** SOC match mode of the existing embed-match edge function: free gte-small + pgvector, read-only. */
const defaultMatcher: SocMatcher = async (chunks) => (await callEmbedMatch({ chunks, matchCount: 10 })).matches ?? [];

/** What the user does, built from the CV profile and the first experience pieces (within the function's limits). */
export function cvSocQuery(cv: CvIndex): string[] {
    const p = cv.profile;
    const head = [
        p.headline,
        `Roles: ${p.roles.map((r) => r.title).join('; ')}`,
        `Skills: ${p.skills.slice(0, 30).map((s) => s.name).join(', ')}`,
    ].join('\n').slice(0, 1800);
    const experience = cv.chunks
        .filter((c) => /experience|employment|work|career|internship/i.test(c.section))
        .slice(0, 1)
        .map((c) => c.text.slice(0, 2000));
    return [head, ...experience];
}

/** Each recent job title searched on its own, so a different field in a career still brings its codes. */
const CV_SOC_ROLE_SEARCHES = 3;
const CV_SOC_CANDIDATES = 15;

function recentRoleTitles(cv: CvIndex): string[] {
    return [...new Set(cv.profile.roles.map((r) => r.title.trim()).filter(Boolean))];
}

const SOURCE = () => {
    const { data } = socDataset();
    return { label: 'GOV.UK Appendix Skilled Worker · CAFY SOC data', url: data.visaSalaryRules.url, date: dataDate(data.generatedAt) };
};

/** The full official figures for one code, as one card. Shared by SOC questions and questions about a listed job. */
export function socFactsCard(code: string): OfficialFactsCard | null {
    const soc = socSummary(code);
    if (!soc) return null;
    return {
        title: `Skilled Worker salary rules for ${soc.code} ${soc.title}`,
        facts: [
            { label: 'New applicants', value: socApplicantRules(code).newApplicants.split(',')[0]!, note: socApplicantRules(code).newApplicants },
            { label: 'Existing visa holders', value: socApplicantRules(code).existingHolders.split(' if ')[0]!.split(' Skilled')[0]!, note: socApplicantRules(code).existingHolders },
            { label: 'Skill level', value: soc.skillLevel ?? 'Not listed', note: soc.note },
            ...soc.thresholds.filter((t) => t.option === 'A').map((t) => ({ label: 'Going rate', value: gbp(t.goingRate), note: `From the official table${t.hourly ? `, £${t.hourly.toFixed(2)} an hour` : ''}.` })),
            ...soc.thresholds.map((t) => ({
                label: `Option ${t.option}`,
                value: gbp(t.threshold),
                note: `${t.condition}. Pay the higher of the ${gbp(t.floorSalary)} floor or the ${gbp(t.goingRate)} rate in the official table (${t.goingRatePercent}% going-rate column${t.hourly ? `, £${t.hourly.toFixed(2)} an hour` : ''}).`,
            })),
        ],
        details: socDetails(code),
        notes: [socDataset().data.visaSalaryRules.note, 'Your employer must also hold a sponsor licence and the job must be genuine. Rules change: confirm on GOV.UK.'],
        source: SOURCE(),
    };
}

export function createUkTools(deps: { match?: SocMatcher; choose?: SocChooser } = {}): AgentTool[] {
    const match = deps.match ?? defaultMatcher;
    const choose = deps.choose ?? createSocChooser();

    const socLookup = defineTool({
        name: 'soc_lookup',
        description:
            'Finds the best UK SOC 2020 occupation codes from official data, for the selected CV (no query) or for a job title or duties the user names (query). Returns code, title, skill level, Skilled Worker eligibility and going-rate thresholds. Never state a SOC code without this tool.',
        args: z.object({ query: z.string().trim().min(2).max(400).optional() }).strict(),
        label: (args) => (args.query ? `Finding the UK SOC code for “${args.query.slice(0, 40)}”` : 'Finding the UK SOC code that fits your CV'),
        async run(args, ctx) {
            // A code the user named is looked up directly: it is a fact, not something to search for.
            if (args.query && /^(?:it|this|that|they|them|this job|that job)$/i.test(args.query.trim())) return { error: 'NEED_ROLE', instruction: 'Use the job or occupation already discussed as the query, or ask which one they mean.' };
            const namedCode = args.query?.match(/\b\d{4}\b|\b\d{2}\s\d{2}\b/)?.[0]?.replace(/\s/, '');
            if (namedCode && !socSummary(namedCode)) return { error: 'UNKNOWN_SOC', instruction: `SOC ${namedCode} is not in the official SOC 2020 list. Say so plainly and offer to find the code from a job title.` };
            const chunks = args.query ? [args.query] : ctx.cv ? cvSocQuery(ctx.cv) : null;
            if (!chunks) return { error: 'NEED_QUERY_OR_CV', instruction: 'Ask for the job title or duties, or for the user to choose a CV.' };
            const hits = namedCode ? [] : await match(chunks);
            const best = new Map<string, number>();
            for (const hit of hits) best.set(hit.soc_code, Math.max(best.get(hit.soc_code) ?? 0, hit.similarity));
            // A job title that is in an occupation's official title list is strong evidence: rank it first.
            if (args.query) {
                const top = Math.max(0, ...best.values());
                for (const code of officialTitleMatches(args.query)) best.set(code, Math.max(best.get(code) ?? 0, top + 0.02));
            }
            // For a CV, closeness alone misleads ("Lean trainer" sits near fitness trainers), so the
            // recent job titles widen the candidates and a small AI step chooses among real codes only.
            // A named title that is not an official one ("Lean Consultant") has the same problem, so it gets the same step.
            const cvMode = !args.query && Boolean(ctx.cv);
            const unofficialTitle = !namedCode && Boolean(args.query) && officialTitleMatches(args.query!).length === 0;
            let chosen: string[] | null = namedCode ? [namedCode] : null;
            if (cvMode || unofficialTitle) {
                const titles = cvMode ? recentRoleTitles(ctx.cv!).slice(0, CV_SOC_ROLE_SEARCHES) : [];
                const roleHits = await Promise.all(titles.map((title) => match([title]).catch(() => [])));
                for (const hit of roleHits.flat()) best.set(hit.soc_code, Math.max(best.get(hit.soc_code) ?? 0, hit.similarity));
                const candidates = [...best.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .flatMap(([code]) => {
                        const summary = socSummary(code);
                        return summary ? [{ code, title: summary.title, examples: summary.exampleJobTitles.slice(0, 6) }] : [];
                    })
                    .slice(0, CV_SOC_CANDIDATES);
                const experience = cvMode ? ctx.cv!.chunks.find((c) => /experience|employment|work|career|internship/i.test(c.section))?.text.slice(0, 1500) : undefined;
                const person = cvMode ? { headline: ctx.cv!.profile.headline, roles: recentRoleTitles(ctx.cv!), experience } : { headline: args.query!, roles: [args.query!] };
                chosen = candidates.length ? await choose(person, candidates, ctx.signal) : [];
                if (chosen && !chosen.length) return { error: 'NO_MATCH', instruction: 'Say no confident SOC match was found and ask for the main job duties.' };
            }
            const ranked = chosen ? chosen.map((code) => [code, best.get(code) ?? 0] as const) : [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
            const options = ranked.flatMap(([code, similarity]) => {
                const summary = socSummary(code);
                // A chosen code shows no percentage: closeness of wording is not how sure the choice is.
                return summary ? [{ ...summary, ...(chosen ? {} : { match: Math.round(similarity * 100) }) }] : [];
            });
            if (!options.length) return { error: 'NO_MATCH', instruction: 'Say no confident SOC match was found and ask for job duties.' };
            // Weak semantic match and no official job-title match: do not present it as certain.
            const titleMatched = args.query ? officialTitleMatches(args.query).length > 0 : false;
            const lowConfidence = namedCode ? false : cvMode || unofficialTitle ? !chosen : !titleMatched && (options[0]!.match ?? 0) < LOW_CONFIDENCE_MATCH;
            const card: SocCardsCard = {
                options: options.map((o) => ({
                    code: o.code,
                    title: o.title,
                    skillLevel: o.skillLevel,
                    eligible: o.eligible,
                    ...socApplicantRules(o.code),
                    note: o.note,
                    generalThreshold: o.generalThreshold,
                    newEntrantThreshold: o.newEntrantThreshold,
                    examples: o.exampleJobTitles,
                    match: o.match,
                })),
                source: SOURCE(),
            };
            ctx.emit('soc-cards', { kind: 'socCards', card });
            return {
                options: options.map(({ thresholds: _t, ...o }) => ({ ...o, ...socApplicantRules(o.code) })),
                source: card.source,
                note: 'Similarity-based suggestion; the employer chooses the SOC code that matches the actual job duties.',
                ...(lowConfidence
                    ? { lowConfidence: true, instruction: 'The match is weak. Present these as possibilities only and ask the user for their main job duties to confirm.' }
                    : {}),
            };
        },
    });

    const visaRules = defineTool({
        name: 'visa_salary_rules',
        description:
            'Current Skilled Worker salary rules from official data: general floor, going-rate rule, new entrant, PhD and Immigration Salary List options, with source and date. Give socCode to get that occupation\'s exact thresholds. Never state visa figures without this tool.',
        args: z.object({ socCode: z.string().regex(/^\d{4}$/).optional() }).strict(),
        label: (args) => (args.socCode ? `Checking Skilled Worker salary rules for SOC ${args.socCode}` : 'Checking current Skilled Worker salary rules'),
        async run(args, ctx) {
            const { data } = socDataset();
            const rules = data.visaSalaryRules;
            const source = SOURCE();
            const options = Object.entries(rules.pointsOptions).map(([option, r]) => ({ option, ...r }));
            const general = rules.pointsOptions.A;
            const newEntrant = rules.pointsOptions.E;
            const isl = rules.pointsOptions.D;
            const soc = args.socCode ? socSummary(args.socCode) : null;
            const unknownSoc = Boolean(args.socCode && !soc);
            const card: OfficialFactsCard = (soc && socFactsCard(soc.code)) || {
                title: 'Skilled Worker salary rules',
                facts: [
                    { label: 'General floor', value: gbp(general?.floorSalary ?? 0), note: 'or the job\'s going rate if higher' },
                    { label: 'New entrant floor', value: gbp(newEntrant?.floorSalary ?? 0), note: `or ${newEntrant?.goingRatePercent ?? 70}% of the going rate if higher` },
                    { label: 'Immigration Salary List', value: gbp(isl?.floorSalary ?? 0), note: 'or the going rate if higher' },
                ],
                notes: [rules.note, 'Your employer must also hold a sponsor licence and the job must be genuine. Rules change: confirm on GOV.UK.'],
                source,
            };
            ctx.emit('official-facts', { kind: 'officialFacts', card });
            return {
                document: rules.document,
                rule: rules.note,
                options,
                // Job titles stay out: long lists are for the card, not the model.
                ...(soc ? { occupation: { ...soc, ...socApplicantRules(soc.code), details: { ...socDetails(soc.code), jobTitles: undefined } } } : {}),
                ...(unknownSoc
                    ? { error: 'UNKNOWN_SOC', instruction: `SOC ${args.socCode} is not in the official SOC 2020 list. Say so, give the general rules, and suggest soc_lookup.` }
                    : {}),
                source,
                instruction:
                    'The card shows the exact figures. Do not repeat or work out any figure or percentage in your text. In words, say who the options are for and what to confirm. Never say whether this specific person will be granted a visa or sponsorship.',
            };
        },
    });

    return [socLookup, visaRules];
}

export const UK_TOOLS = createUkTools();
