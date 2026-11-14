import type { AutofillFillInput, AutofillProfile, ScrapedFieldInput } from '../schemas/autofill';

/*
 * Repeatable sections: forms show one (or zero) blank block per section plus an "Add another" button.
 * Decides, without AI, how many times to click each button so there is a block per resume entry.
 */

type Section = {
    name: string;
    /** Matches the button's label / section heading */
    button: RegExp;
    /** One field per existing block (counts blocks already on the form) */
    anchor: RegExp;
    /** How many blocks the resume can fill */
    wanted: (profile: AutofillProfile) => number;
};

const SECTIONS: Section[] = [
    {
        name: 'experience',
        button: /experience|employment|work\s+history|\bjob\b|position|employer/i,
        anchor: /company|employer|organi[sz]ation\s+name/i,
        // Older roles rarely matter to the application and every extra block is more to review.
        wanted: (p) => Math.min(p.experience.length, 5),
    },
    {
        name: 'education',
        button: /education|school|degree|qualification|academic/i,
        // "Place of study": UK public-sector forms (Trac, NHS Jobs) lay education out as a table with that column
        anchor: /school|universit|college|institution|place\s+of\s+study/i,
        wanted: (p) => Math.min(p.education.length, 3),
    },
    {
        name: 'language',
        button: /language/i,
        anchor: /^\s*language/i,
        wanted: (p) => Math.min(p.languages.length, 5),
    },
    {
        name: 'certification',
        button: /certific|licen[cs]e/i,
        anchor: /certific|licen[cs]e/i,
        wanted: (p) => Math.min(p.certifications.length, 5),
    },
    {
        name: 'link',
        button: /website|\blinks?\b|\burl\b|social|portfolio/i,
        anchor: /website|\blink\b|\burl\b|linkedin|github|portfolio/i,
        wanted: (p) => [p.links.linkedin, p.links.github, p.links.portfolio, ...p.links.other].filter(Boolean).length,
    },
];

/** Longest label still counted as a block's field ("Company name *", "School or university"). */
const MAX_ANCHOR_LABEL = 40;

/** Never click more than this per section, whatever the resume says. */
const MAX_CLICKS = 5;

const fieldText = (f: ScrapedFieldInput) => f.label ?? f.placeholder ?? f.name ?? '';

export function planExpansion(
    input: Pick<AutofillFillInput, 'fields' | 'addButtons'>,
    profile: AutofillProfile
): { buttonId: string; times: number; section: string }[] {
    const plan: { buttonId: string; times: number; section: string }[] = [];

    for (const section of SECTIONS) {
        // Some forms repeat the button under every block; the last one adds after the last block.
        const button = input.addButtons.filter((b) => section.button.test(`${b.label} ${b.section ?? ''}`)).at(-1);
        if (!button) continue;
        // "Add another" inside Experience would otherwise match both experience and a later section's words
        if (plan.some((p) => p.buttonId === button.buttonId)) continue;

        // Short labels only: a block's "Company" box, not a sentence that mentions the company
        // ("Let the company know about your interest" - SmartRecruiters' message box)
        const existing = input.fields.filter((f) => {
            const text = fieldText(f);
            return f.type !== 'file' && text.length <= MAX_ANCHOR_LABEL && section.anchor.test(text);
        }).length;
        const times = Math.min(section.wanted(profile) - existing, MAX_CLICKS);
        if (times > 0) plan.push({ buttonId: button.buttonId, times, section: section.name });
    }

    return plan;
}
