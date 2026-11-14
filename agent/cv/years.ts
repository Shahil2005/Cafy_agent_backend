/**
 * Years of experience worked out by code from CV dates, never by the model.
 * Overlapping roles are merged so two jobs at once are not double counted.
 */

export interface DatedRole {
    title: string;
    start?: string;
    end?: string;
}

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Months since year 0 for "2023", "2023-04", "Apr 2023", "04/2023"; null when unreadable. */
export function parseCvDate(value: string | undefined, now: Date, isEnd: boolean): number | null {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    if (/^(?:present|current|now|today|ongoing|to date)$/.test(v)) return now.getUTCFullYear() * 12 + now.getUTCMonth();
    let m = v.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (m) return Number(m[1]) * 12 + Number(m[2]) - 1;
    m = v.match(/^(\d{1,2})[-/.](\d{4})$/);
    if (m) return Number(m[2]) * 12 + Number(m[1]) - 1;
    m = v.match(/^([a-z]{3,9})\.?\s+(\d{4})$/);
    if (m && MONTHS[m[1]!.slice(0, 4)] !== undefined) return Number(m[2]) * 12 + MONTHS[m[1]!.slice(0, 4)]! - 1;
    if (m && MONTHS[m[1]!.slice(0, 3)] !== undefined) return Number(m[2]) * 12 + MONTHS[m[1]!.slice(0, 3)]! - 1;
    m = v.match(/^(\d{4})$/);
    // A bare year counts from January when it starts a role and to December when it ends one.
    if (m) return Number(m[1]) * 12 + (isEnd ? 11 : 0);
    return null;
}

export interface ExperienceSummary {
    totalMonths: number;
    years: number;
    roles: Array<{ title: string; months: number | null }>;
    undatedRoles: string[];
}

export function experienceYears(roles: DatedRole[], now = new Date()): ExperienceSummary {
    const ranges: Array<[number, number]> = [];
    const perRole: ExperienceSummary['roles'] = [];
    const undated: string[] = [];
    const cap = now.getUTCFullYear() * 12 + now.getUTCMonth();
    for (const role of roles) {
        const start = parseCvDate(role.start, now, false);
        // "Saturday job, 2025" is that one year; only a stated "present" or a start with a month runs on to today.
        const end = parseCvDate(role.end ?? (/^\d{4}$/.test(role.start?.trim() ?? '') ? role.start : 'present'), now, true);
        if (start === null || end === null || end < start) {
            undated.push(role.title);
            perRole.push({ title: role.title, months: null });
            continue;
        }
        const bounded: [number, number] = [start, Math.min(end, cap)];
        ranges.push(bounded);
        perRole.push({ title: role.title, months: Math.max(1, bounded[1] - bounded[0] + 1) });
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let current: [number, number] | null = null;
    for (const range of ranges) {
        if (current && range[0] <= current[1] + 1) current[1] = Math.max(current[1], range[1]);
        else {
            if (current) total += current[1] - current[0] + 1;
            current = [range[0], range[1]];
        }
    }
    if (current) total += current[1] - current[0] + 1;
    return { totalMonths: total, years: Math.round((total / 12) * 10) / 10, roles: perRole, undatedRoles: undated };
}
