import { z } from 'zod';
import { defineTool } from './types';

/**
 * Changes the look of the tailored CV ("/cv") on the user's screen. The browser draws the PDF, so
 * this only names a template: no AI rewrites the CV and no tokens are spent on its content.
 * Mirrors Product-Site `src/components/cafy-agent/tailor/cvTemplates.ts` (ids and names); keep both in step.
 */
export const CV_TEMPLATE_CATALOGUE = [
    { id: 'classic', name: 'Classic', suits: 'the default: centred header, blue headings, plain sans-serif. Safe for any job.' },
    { id: 'modern', name: 'Modern', suits: 'left-aligned, teal accent blocks. Tech, digital, start-ups; "more modern", "fresher", "colourful".' },
    { id: 'executive', name: 'Executive', suits: 'serif type in navy. Senior, finance, legal, consulting; "more formal", "traditional", "elegant", "serif".' },
    { id: 'minimal', name: 'Minimal', suits: 'black and grey only, lots of white space. "simpler", "cleaner", "no colour", "plain", "black and white".' },
    { id: 'compact', name: 'Compact', suits: 'tighter spacing and one-line roles. "fit on one page", "shorter", "denser", long CVs.' },
    { id: 'banner', name: 'Banner', suits: 'name on a coloured band at the top. "stand out", "bolder", "more eye-catching", creative and marketing roles.' },
    { id: 'graduate', name: 'Graduate', suits: 'serif, education and projects first. Students, graduates, little work experience, academic roles.' },
] as const;

export type CvTemplateId = (typeof CV_TEMPLATE_CATALOGUE)[number]['id'];
const IDS = CV_TEMPLATE_CATALOGUE.map((t) => t.id) as [CvTemplateId, ...CvTemplateId[]];

/** The next template after the current one, for "a different one" with no preference. */
export function nextTemplate(current: string | undefined): (typeof CV_TEMPLATE_CATALOGUE)[number] {
    const at = CV_TEMPLATE_CATALOGUE.findIndex((t) => t.id === current);
    return CV_TEMPLATE_CATALOGUE[(at + 1) % CV_TEMPLATE_CATALOGUE.length];
}

export const CV_TEMPLATE_TOOL = defineTool({
    name: 'change_cv_template',
    description:
        'Changes the template (design, layout, style, font, colours or look) of the tailored CV on the user\'s screen, in any wording or language: "another template", "make it look more modern", "something more formal", "fit it on one page". '
        + 'Pass "template" as the one that best fits what they asked for; leave it out when they just want a different one. Its wording does not change. Templates: '
        + CV_TEMPLATE_CATALOGUE.map((t) => `${t.id} (${t.suits})`).join('; '),
    args: z.object({ template: z.enum(IDS).optional() }).strict(),
    label: () => 'Changing your CV template',
    async run(args, ctx) {
        const current = ctx.tailoredCv?.template;
        const others = (except: string) => CV_TEMPLATE_CATALOGUE.filter((t) => t.id !== except).map((t) => t.name);
        if (!current) {
            return { error: 'NO_TAILORED_CV', instruction: 'No tailored CV is on screen. Say to type /cv to tailor their CV to a job first; they can then ask for any template.' };
        }
        if (args.template && args.template === current) {
            const same = CV_TEMPLATE_CATALOGUE.find((t) => t.id === current)!;
            return { alreadyUsing: same.name, otherTemplates: others(current), instruction: 'Say the CV already uses this template and name two others they could try.' };
        }
        const chosen = args.template ? CV_TEMPLATE_CATALOGUE.find((t) => t.id === args.template)! : nextTemplate(current);
        ctx.emit('cv-template', { kind: 'cvTemplate', template: chosen.id, name: chosen.name });
        return {
            changedTo: chosen.name,
            looks: chosen.suits,
            otherTemplates: others(chosen.id),
            instruction: 'In one or two short sentences: say the tailored CV now uses this template (its preview has updated and Download PDF saves it), and that its wording is unchanged and it stays ATS-friendly. Offer one or two other templates as suggestions.',
        };
    },
});
