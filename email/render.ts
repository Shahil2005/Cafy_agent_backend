import * as fs from 'fs';
import * as path from 'path';

const CACHE = new Map<string, string>();

function templateCandidates(filename: string): string[] {
    return [
        path.join(process.cwd(), 'email', 'templates', filename),
        path.join(__dirname, 'templates', filename),
        path.join(process.cwd(), 'dist', 'email', 'templates', filename),
    ];
}

export function loadEmailTemplate(filename: string): string {
    const cached = CACHE.get(filename);
    if (cached) return cached;

    for (const candidate of templateCandidates(filename)) {
        if (fs.existsSync(candidate)) {
            const html = fs.readFileSync(candidate, 'utf8');
            CACHE.set(filename, html);
            return html;
        }
    }

    throw new Error(`Email template not found: ${filename}`);
}

export function interpolateTemplate(html: string, vars: Record<string, string | number>): string {
    return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
        const value = vars[key];
        return value === undefined || value === null ? '' : String(value);
    });
}

export function htmlToPlainText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&rarr;/gi, '->')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
}
