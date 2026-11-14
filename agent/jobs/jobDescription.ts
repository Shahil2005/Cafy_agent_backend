/**
 * A job advert pasted into the chat ("<advert> give me jobs like this for my CV").
 *
 * The advert is data, not the user's request: its place, pay, company and words such as "visa" or
 * "right to work" must not turn into search filters or trigger other lookups. So the message is split
 * into the advert and the user's own words ("ask"); intent checks read only the ask, and job search
 * uses the advert's full text as the meaning query.
 */

/** Long enough to be an advert, not a question that mentions one. */
const MIN_ADVERT_CHARS = 300;
/** Used for the search and stored with the results, so "more" searches the same advert. */
export const MAX_ADVERT_CHARS = 6000;
const MAX_ASK_CHARS = 300;

const ADVERT_SIGNALS = [
    /\b(?:key\s+)?responsibilit(?:y|ies)\b/i,
    /\brequirements?\b|\bessential\b|\bdesirable\b/i,
    /\babout (?:the|this) (?:role|job|position)\b|\bthe role\b/i,
    /\bwhat you(?:'|’)?ll (?:do|bring|need)\b|\babout you\b|\bwho you are\b/i,
    /\bqualifications?\b|\bskills (?:and|&) experience\b|\bexperience (?:in|with|of)\b/i,
    /\bsalary\b|\bper annum\b|\bbenefits\b|\bpension\b|\bholiday\b/i,
    /\bwe are (?:looking|seeking|hiring)\b|\bjoin (?:our|the) team\b|\byou will\b/i,
    /\b(?:full|part)[- ]time\b|\bhybrid\b|\bpermanent\b|\bcontract\b/i,
];
const ADDRESSED = /\b(?:me|my|i|i'm|i am|can you|could you|please|find|show|give|search|similar|like (?:this|it|that|these))\b/i;
/** "but in Manchester please", "only remote ones": the user narrowing their request after the advert. */
const CONTINUATION = /^(?:but|and|only|just|preferably|ideally|in|near|around)\b.*\b(?:please|ones?|jobs?|roles?|instead)\b|^(?:but|only|preferably|ideally)\b/i;
const BULLET =/^(?:[-*•·▪◦]|\d{1,2}[.)])\s/;
const REQUEST = /\b(?:jobs?|roles?|positions?|vacanc(?:y|ies)|openings?|find|show|give|search|look(?:ing)? for|similar|like (?:this|it|that)|matching|match|suit|fit|apply)\b/i;

export interface PastedAdvert {
    /** The advert text, trimmed to MAX_ADVERT_CHARS. */
    advert: string;
    /** The user's own words around it; empty when they pasted only the advert. */
    ask: string;
}

function bulletLines(text: string): number {
    return text.split('\n').filter((line) => BULLET.test(line.trim())).length;
}

/** The advert and the user's own words, or null when the message is not a pasted advert. */
export function splitPastedAdvert(message: string): PastedAdvert | null {
    const text = message.replace(/\r\n?/g, '\n').trim();
    if (text.length < MIN_ADVERT_CHARS) return null;
    const signals = ADVERT_SIGNALS.filter((signal) => signal.test(text)).length;
    if (signals < 3 && !(signals >= 2 && bulletLines(text) >= 3)) return null;

    // The user's words sit on the first line or the last one or two: short, asking for something, and
    // addressed to us. An advert's own closing line ("Apply now via our website") is not a request.
    const lines = text.split('\n').map((line) => line.trim());
    const isAsk = (line: string) => line.length > 0 && line.length <= MAX_ASK_CHARS && REQUEST.test(line) && ADDRESSED.test(line) && !BULLET.test(line);
    let start = 0;
    let end = lines.length;
    const head = isAsk(lines[0]!) ? [lines[start++]!] : [];
    const tail: string[] = [];
    while (end > start) {
        const line = lines[end - 1]!;
        if (!line) end--;
        else if (tail.length < 2 && (isAsk(line) || (line.length <= 80 && CONTINUATION.test(line)))) {
            tail.unshift(line);
            end--;
        } else break;
    }
    const ask = [...head, ...tail];
    const advert = lines.slice(start, end).join('\n').trim();
    if (advert.length < MIN_ADVERT_CHARS * 0.8) return null;
    return { advert: advert.slice(0, MAX_ADVERT_CHARS), ask: ask.join(' ').trim() };
}

/** The words intent checks should read: only what the user wrote when they pasted an advert. */
export function userWords(message: string): string {
    const pasted = splitPastedAdvert(message);
    return pasted ? pasted.ask : message;
}

/** CV skills and titles the advert also names: the shared ground, used only to break ties between jobs. */
export function sharedKeywords(cvKeywords: string[], advert: string): string[] {
    const text = ` ${advert.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ')} `;
    return cvKeywords.filter((word) => {
        const key = word.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
        return key.length >= 2 && text.includes(` ${key} `);
    });
}
