import { z } from 'zod';
import type { CvProfileCard } from '../contract';
import { cvExperience, searchCv, type CvIndex } from '../cv';
import { defineTool, type ToolContext } from './types';

const NO_CV = {
    error: 'NO_CV_SELECTED',
    instruction: 'No CV is selected. Ask the user to choose one of the CVs saved in their CAFY profile using the picker shown below.',
};

function requireCv(ctx: ToolContext): CvIndex | null {
    if (ctx.cv) return ctx.cv;
    ctx.emit('cv-picker', { kind: 'cvPicker' });
    return null;
}

function dates(start?: string, end?: string): string | undefined {
    if (!start && !end) return undefined;
    return `${start ?? '?'} – ${end ?? 'present'}`;
}

export function cvProfileCard(index: CvIndex): CvProfileCard {
    const p = index.profile;
    return {
        name: index.name,
        headline: p.headline,
        years: cvExperience(index).years,
        // Everything is sent; the card shows the first few with "Show all".
        roles: p.roles.map((r) => ({ title: r.title, employer: r.employer, dates: dates(r.start, r.end) })),
        education: p.education.map((e) => ({ qualification: e.qualification, institution: e.institution, dates: dates(e.start, e.end) })),
        skills: p.skills.map((s) => ({ name: s.name, source: s.source })),
        projects: p.projects.map((pr) => pr.name),
        counts: {
            roles: p.roles.length,
            skills: p.skills.length,
            projects: p.projects.length,
            achievements: p.achievements.length,
            certifications: p.certifications.length,
        },
        hasPersonalStatement: p.hasPersonalStatement,
    };
}

const getCvProfile = defineTool({
    name: 'get_cv_profile',
    description:
        "The user's selected CV as a structured profile: roles with dates, education, skills (with where each was used), projects, achievements, certifications, languages. Each item has an exact evidence quote. Shows the CV card only when the user asked for an overview.",
    args: z.object({}).strict(),
    label: () => 'Reading your CV profile',
    // The whole profile, so answers about any role, course or certificate are complete.
    maxResultChars: 40_000,
    async run(_args, ctx) {
        const cv = requireCv(ctx);
        if (!cv) return NO_CV;
        if (ctx.showCvCard) ctx.emit('cv-profile', { kind: 'cvProfile', card: cvProfileCard(cv) });
        return { cvName: cv.name, ...cv.profile, experience: cvExperience(cv) };
    },
});

const searchCvTool = defineTool({
    name: 'search_cv',
    description:
        "Searches the WHOLE selected CV by meaning and returns the most relevant passages with their section. Use for any detail question (e.g. 'leadership', 'Python at work', 'gap in 2022').",
    args: z.object({ query: z.string().trim().min(2).max(200) }).strict(),
    label: (args) => `Searching your whole CV for “${args.query.slice(0, 40)}”`,
    async run(args, ctx) {
        const cv = requireCv(ctx);
        if (!cv) return NO_CV;
        const hits = await searchCv(cv, args.query);
        return { passages: hits.map((h) => ({ section: h.section, text: h.text.slice(0, 1200), relevance: h.score })) };
    },
});

const experienceTool = defineTool({
    name: 'get_experience_years',
    description:
        'Years of professional experience worked out from the CV dates (overlaps merged, projects and education excluded). Always use this instead of calculating yourself.',
    args: z.object({}).strict(),
    label: () => 'Working out your experience from CV dates',
    async run(_args, ctx) {
        const cv = requireCv(ctx);
        if (!cv) return NO_CV;
        return cvExperience(cv);
    },
});

export const CV_TOOLS = [getCvProfile, searchCvTool, experienceTool];
