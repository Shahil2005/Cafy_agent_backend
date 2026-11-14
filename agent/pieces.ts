/**
 * Repairs common near-miss shapes from the model before validation, so a good answer is not
 * lost because a list item came back as {"label","text"} instead of a string, or a piece used
 * a synonym such as "bullets". Anything still invalid afterwards is dropped by the schema.
 */

const TYPE_ALIASES: Record<string, string> = {
    bullets: 'tips',
    bulletlist: 'tips',
    bullet_list: 'tips',
    checklist: 'tips',
    numbered: 'steps',
    numberedlist: 'steps',
    numbered_list: 'steps',
    process: 'steps',
    note: 'paragraph',
    info: 'paragraph',
    text: 'paragraph',
    caution: 'warning',
    alert: 'warning',
    disclaimer: 'warning',
    sample: 'example',
    template: 'example',
    code: 'example',
    cards: 'list',
    roles: 'list',
    options: 'list',
    items: 'list',
    table: 'list',
    dodont: 'doDont',
    do_dont: 'doDont',
    stats: 'facts',
    keyfacts: 'facts',
};

function obj(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    return undefined;
}

/** A long line becomes a title cut at a word, with the whole line kept as its text. */
function shortItem(line: string): { title: string; text?: string } {
    if (line.length <= 80) return { title: line };
    return { title: `${line.slice(0, 80).replace(/\s+\S*$/, '')}…`, text: line };
}

function titleOf(item: Record<string, unknown>): string | undefined {
    return str(item.title) ?? str(item.label) ?? str(item.name) ?? str(item.role) ?? str(item.heading) ?? str(item.step);
}

function bodyOf(item: Record<string, unknown>): string | undefined {
    const value = item.text ?? item.description ?? item.details ?? item.detail ?? item.summary ?? item.value ?? item.content;
    if (Array.isArray(value)) return value.map(str).filter(Boolean).join('; ') || undefined;
    return str(value);
}

/** "Title: body" for object items; strings pass through. */
function asLine(item: unknown): string | undefined {
    if (!obj(item)) return str(item);
    const title = titleOf(item);
    const body = bodyOf(item);
    return title && body ? `${title}: ${body}` : (title ?? body);
}

function lines(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map(asLine).filter((line): line is string => Boolean(line));
}

export function coercePiece(raw: unknown): unknown {
    if (!obj(raw)) return raw;
    const piece: Record<string, unknown> = { ...raw };
    const rawType = str(piece.type)?.replace(/[\s-]/g, '') ?? '';
    const type = TYPE_ALIASES[rawType.toLowerCase()] ?? rawType;
    piece.type = type;

    if (type === 'list') {
        const items = Array.isArray(piece.items) ? piece.items : [];
        piece.items = items.flatMap((item) => {
            if (obj(item)) {
                const title = titleOf(item);
                const text = bodyOf(item);
                return title ? [{ title, ...(text ? { text } : {}) }] : text ? [shortItem(text)] : [];
            }
            const line = str(item);
            if (!line) return [];
            const split = line.match(/^(.{2,80}?):\s+(.+)$/);
            return [split ? { title: split[1], text: split[2] } : shortItem(line)];
        });
        if (piece.title === undefined && str(piece.heading)) piece.title = str(piece.heading);
        return piece;
    }
    if (type === 'steps' || type === 'tips') {
        piece.items = lines(piece.items) ?? lines(piece.steps) ?? lines(piece.tips) ?? piece.items;
        return piece;
    }
    if (type === 'doDont') {
        piece.do = lines(piece.do) ?? lines(piece.dos) ?? [];
        piece.dont = lines(piece.dont) ?? lines(piece.donts) ?? lines(piece.avoid) ?? [];
        return piece;
    }
    if (type === 'facts' && Array.isArray(piece.items)) {
        piece.items = piece.items.map((item) =>
            obj(item) ? { label: titleOf(item) ?? str(item.key), value: bodyOf(item) ?? str(item.number) } : item,
        );
        return piece;
    }
    if (type === 'paragraph' || type === 'warning' || type === 'heading') {
        if (!str(piece.text) && str(piece.content)) piece.text = str(piece.content);
        return piece;
    }
    if (type === 'example') {
        if (!str(piece.text)) piece.text = str(piece.content) ?? str(piece.example) ?? str(piece.body);
        return piece;
    }
    return piece;
}
