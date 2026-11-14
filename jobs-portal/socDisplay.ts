/** What the UK jobs list shows. Stored soc_alternatives stay on the row for analysis. */

export type JobsTableSocMatch = {
    code: string;
    title: string;
    /** Whole-number percent of the vote. The top 3 are not rescaled to 100. */
    percent: number;
};

export type JobsTableSoc =
    | { kind: 'single'; code: string; title: string; reason: string }
    | { kind: 'candidates'; matches: JobsTableSocMatch[]; reason: string };

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function percentFromShare(share: unknown): number | null {
    const n = typeof share === 'number' ? share : Number(share);
    if (!Number.isFinite(n) || n < 0 || n > 1) return null;
    return Math.round(n * 100);
}

/** Extra codes under this percent stay off the job. The strongest code is still shown. */
const MIN_ALTERNATIVE_PERCENT = 40;

function candidates(value: unknown): JobsTableSocMatch[] {
    if (!Array.isArray(value)) return [];
    const ranked: JobsTableSocMatch[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const code = text(row.code);
        if (!/^\d{4}$/.test(code)) continue;
        const percent = percentFromShare(row.share);
        if (percent == null) continue;
        ranked.push({ code, title: text(row.title), percent });
    }
    ranked.sort((a, b) => b.percent - a.percent);
    const shown = ranked.filter((match) => match.percent >= MIN_ALTERNATIVE_PERCENT).slice(0, 3);
    if (shown.length) return shown;
    return ranked.slice(0, 1);
}

function clip(value: string, max = 240): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max).trimEnd()}…`;
}

/** Match sentences only. Pay, visa-route, and sponsor sentences stay off this line. */
function matchReason(value: unknown, ids: string[]): string {
    if (!Array.isArray(value)) return '';
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const row = item as { id?: unknown; text?: unknown };
        if (!ids.includes(text(row.id))) continue;
        const sentence = text(row.text);
        if (sentence) return sentence;
    }
    return '';
}

function withEvidence(reason: string, evidence: string): string {
    if (!evidence || reason.includes(evidence)) return reason;
    const fromAdvert = `Matched from the advert: "${clip(evidence)}".`;
    return reason ? `${reason} ${fromAdvert}` : fromAdvert;
}

/**
 * High confidence: one code. Alternatives are not included.
 * Low confidence: up to 3 codes at 40% or more, strongest first. A weaker best guess is shown alone.
 * Low confidence with no candidates yet: nothing, so the lone stored code is not shown as certain.
 * reason is why that match was made.
 */
export function jobsTableSocDisplay(row: {
    soc_code?: unknown;
    soc_title?: unknown;
    soc_confidence?: unknown;
    soc_alternatives?: unknown;
    soc_evidence?: unknown;
    sponsorship_reasons?: unknown;
}): JobsTableSoc | null {
    const confidence = text(row.soc_confidence);
    const evidence = text(row.soc_evidence);
    if (confidence === 'high') {
        const code = text(row.soc_code);
        if (!/^\d{4}$/.test(code)) return null;
        return {
            kind: 'single',
            code,
            title: text(row.soc_title),
            reason: withEvidence(matchReason(row.sponsorship_reasons, ['occupation']), evidence),
        };
    }
    if (confidence === 'low') {
        const matches = candidates(row.soc_alternatives);
        if (!matches.length) return null;
        return {
            kind: 'candidates',
            matches,
            reason: withEvidence(matchReason(row.sponsorship_reasons, ['best_guess']), evidence),
        };
    }
    return null;
}
