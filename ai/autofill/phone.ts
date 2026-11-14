import type { AutofillProfile, ScrapedFieldInput } from '../schemas/autofill';

/*
 * Phone numbers and dial-code dropdowns are filled by rule, not by the AI:
 * - the number is split into country calling code + national number,
 * - a dial-code dropdown gets the option with exactly that code (and the candidate's country when several
 *   countries share it: +44 is also Guernsey / Jersey / Isle of Man, +1 is the US and Canada),
 * - the phone box gets the national number when the form has a separate code dropdown or no room for the
 *   code, else the full international number. Phone numbers are never truncated.
 */

type CallingCode = { code: string; iso: string; names: string[] };

// Main calling codes. Several countries sharing a code are listed under the code; the first is the default.
const CALLING_CODES: CallingCode[] = [
    { code: '1', iso: 'US', names: ['united states', 'usa', 'us', 'america'] },
    { code: '1', iso: 'CA', names: ['canada'] },
    { code: '7', iso: 'RU', names: ['russia', 'russian federation'] },
    { code: '7', iso: 'KZ', names: ['kazakhstan'] },
    { code: '20', iso: 'EG', names: ['egypt'] },
    { code: '27', iso: 'ZA', names: ['south africa'] },
    { code: '30', iso: 'GR', names: ['greece'] },
    { code: '31', iso: 'NL', names: ['netherlands', 'holland'] },
    { code: '32', iso: 'BE', names: ['belgium'] },
    { code: '33', iso: 'FR', names: ['france'] },
    { code: '34', iso: 'ES', names: ['spain'] },
    { code: '36', iso: 'HU', names: ['hungary'] },
    { code: '39', iso: 'IT', names: ['italy'] },
    { code: '40', iso: 'RO', names: ['romania'] },
    { code: '41', iso: 'CH', names: ['switzerland'] },
    { code: '43', iso: 'AT', names: ['austria'] },
    { code: '44', iso: 'GB', names: ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland', 'gb'] },
    { code: '45', iso: 'DK', names: ['denmark'] },
    { code: '46', iso: 'SE', names: ['sweden'] },
    { code: '47', iso: 'NO', names: ['norway'] },
    { code: '48', iso: 'PL', names: ['poland'] },
    { code: '49', iso: 'DE', names: ['germany', 'deutschland'] },
    { code: '51', iso: 'PE', names: ['peru'] },
    { code: '52', iso: 'MX', names: ['mexico'] },
    { code: '54', iso: 'AR', names: ['argentina'] },
    { code: '55', iso: 'BR', names: ['brazil', 'brasil'] },
    { code: '56', iso: 'CL', names: ['chile'] },
    { code: '57', iso: 'CO', names: ['colombia'] },
    { code: '60', iso: 'MY', names: ['malaysia'] },
    { code: '61', iso: 'AU', names: ['australia'] },
    { code: '62', iso: 'ID', names: ['indonesia'] },
    { code: '63', iso: 'PH', names: ['philippines'] },
    { code: '64', iso: 'NZ', names: ['new zealand'] },
    { code: '65', iso: 'SG', names: ['singapore'] },
    { code: '66', iso: 'TH', names: ['thailand'] },
    { code: '81', iso: 'JP', names: ['japan'] },
    { code: '82', iso: 'KR', names: ['south korea', 'korea', 'republic of korea'] },
    { code: '84', iso: 'VN', names: ['vietnam', 'viet nam'] },
    { code: '86', iso: 'CN', names: ['china'] },
    { code: '90', iso: 'TR', names: ['turkey', 'türkiye', 'turkiye'] },
    { code: '91', iso: 'IN', names: ['india'] },
    { code: '92', iso: 'PK', names: ['pakistan'] },
    { code: '93', iso: 'AF', names: ['afghanistan'] },
    { code: '94', iso: 'LK', names: ['sri lanka'] },
    { code: '95', iso: 'MM', names: ['myanmar', 'burma'] },
    { code: '98', iso: 'IR', names: ['iran'] },
    { code: '212', iso: 'MA', names: ['morocco'] },
    { code: '213', iso: 'DZ', names: ['algeria'] },
    { code: '216', iso: 'TN', names: ['tunisia'] },
    { code: '233', iso: 'GH', names: ['ghana'] },
    { code: '234', iso: 'NG', names: ['nigeria'] },
    { code: '254', iso: 'KE', names: ['kenya'] },
    { code: '255', iso: 'TZ', names: ['tanzania'] },
    { code: '256', iso: 'UG', names: ['uganda'] },
    { code: '263', iso: 'ZW', names: ['zimbabwe'] },
    { code: '351', iso: 'PT', names: ['portugal'] },
    { code: '352', iso: 'LU', names: ['luxembourg'] },
    { code: '353', iso: 'IE', names: ['ireland', 'republic of ireland'] },
    { code: '354', iso: 'IS', names: ['iceland'] },
    { code: '356', iso: 'MT', names: ['malta'] },
    { code: '357', iso: 'CY', names: ['cyprus'] },
    { code: '358', iso: 'FI', names: ['finland'] },
    { code: '359', iso: 'BG', names: ['bulgaria'] },
    { code: '370', iso: 'LT', names: ['lithuania'] },
    { code: '371', iso: 'LV', names: ['latvia'] },
    { code: '372', iso: 'EE', names: ['estonia'] },
    { code: '380', iso: 'UA', names: ['ukraine'] },
    { code: '381', iso: 'RS', names: ['serbia'] },
    { code: '385', iso: 'HR', names: ['croatia'] },
    { code: '386', iso: 'SI', names: ['slovenia'] },
    { code: '420', iso: 'CZ', names: ['czech republic', 'czechia'] },
    { code: '421', iso: 'SK', names: ['slovakia'] },
    { code: '852', iso: 'HK', names: ['hong kong'] },
    { code: '880', iso: 'BD', names: ['bangladesh'] },
    { code: '886', iso: 'TW', names: ['taiwan'] },
    { code: '960', iso: 'MV', names: ['maldives'] },
    { code: '961', iso: 'LB', names: ['lebanon'] },
    { code: '962', iso: 'JO', names: ['jordan'] },
    { code: '965', iso: 'KW', names: ['kuwait'] },
    { code: '966', iso: 'SA', names: ['saudi arabia'] },
    { code: '968', iso: 'OM', names: ['oman'] },
    { code: '971', iso: 'AE', names: ['united arab emirates', 'uae', 'emirates'] },
    { code: '972', iso: 'IL', names: ['israel'] },
    { code: '973', iso: 'BH', names: ['bahrain'] },
    { code: '974', iso: 'QA', names: ['qatar'] },
    { code: '977', iso: 'NP', names: ['nepal'] },
];

export type ParsedPhone = {
    /** Calling code digits, e.g. "44" */
    code: string;
    iso: string;
    countryNames: string[];
    /** National significant number, digits only, no trunk "0" (e.g. "7911123456") */
    national: string;
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

function countryFromName(country: string | null): CallingCode | null {
    const c = norm(country);
    if (!c) return null;
    return CALLING_CODES.find((cc) => cc.names.includes(c) || cc.iso.toLowerCase() === c) ?? null;
}

/**
 * Splits a resume phone number. "+44 7911 123456" → 44 / 7911123456. Without a "+", the candidate's country
 * gives the code and a leading trunk "0" is dropped ("07911 123456" in the UK → 44 / 7911123456).
 */
export function parsePhone(phone: string | null, country: string | null): ParsedPhone | null {
    if (!phone) return null;
    const raw = phone.trim();
    let digits = raw.replace(/\D/g, '');
    if (digits.length < 6) return null;

    const hint = countryFromName(country);
    const international = raw.startsWith('+') || raw.startsWith('00');
    if (raw.startsWith('00')) digits = digits.slice(2);

    if (international) {
        // Longest code first ("353" before "35"); among countries sharing it, prefer the candidate's
        for (const len of [3, 2, 1]) {
            const code = digits.slice(0, len);
            const matches = CALLING_CODES.filter((cc) => cc.code === code);
            if (matches.length) {
                const cc = matches.find((m) => m.iso === hint?.iso) ?? matches[0];
                return { code, iso: cc.iso, countryNames: cc.names, national: digits.slice(len).replace(/^0+/, '') };
            }
        }
        return null;
    }

    if (!hint) return null;
    // "91 98765 43210" / "447911123456" written without "+": the code is already there
    if (digits.length > 10 && digits.startsWith(hint.code)) {
        return { code: hint.code, iso: hint.iso, countryNames: hint.names, national: digits.slice(hint.code.length).replace(/^0+/, '') };
    }
    return { code: hint.code, iso: hint.iso, countryNames: hint.names, national: digits.replace(/^0+/, '') };
}

/* ---------------------------------------------------------------------------
 * Field detection
 * ------------------------------------------------------------------------- */

const CODE_LABEL = /country\s*code|dial(l?ing)?\s*code|calling\s*code|phone\s*(country|code|prefix)|mobile\s*(country|code|prefix)|\bisd\b|country\s*prefix/i;
const DIAL_OPTION = /\+\s?\d{1,4}\b|\(\s*\d{1,4}\s*\)/;
const PHONE_LABEL = /phone|mobile|\bcell\b|contact\s*(no|number)|whats\s*app|\btel\b|telephone/i;
const NOT_A_NUMBER = /extension|\bext\b|type|kind|verify|otp|code/i;

const textOf = (f: ScrapedFieldInput) => [f.label, f.name, f.id, f.placeholder].filter(Boolean).join(' ');

/** A dropdown of dial codes: labelled like one, or most of its options carry "+NN". */
export function isPhoneCodeField(field: ScrapedFieldInput): boolean {
    if (field.type === 'file' || field.type === 'checkbox') return false;
    if (CODE_LABEL.test(textOf(field))) {
        // "Phone number with country code" is the number box itself, asking for the full number
        const numberBox = !field.options.length && (field.type === 'tel' || /\bnumber\b|\bno\.?\b|#/i.test(field.label ?? ''));
        return !numberBox;
    }
    if (field.options.length < 5) return false;
    const withCode = field.options.filter((o) => DIAL_OPTION.test(`${o.label} ${o.value}`)).length;
    return withCode / field.options.length >= 0.6;
}

export function isPhoneNumberField(field: ScrapedFieldInput): boolean {
    if (field.options.length || isPhoneCodeField(field)) return false;
    if (field.type === 'tel') return !NOT_A_NUMBER.test(textOf(field)) || /phone|mobile/i.test(field.label ?? '');
    const ac = norm(field.autocomplete);
    if (ac.endsWith('tel') || ac.endsWith('tel-national')) return true;
    return ['text', 'number', 'autocomplete'].includes(field.type) && PHONE_LABEL.test(textOf(field)) && !NOT_A_NUMBER.test(field.label ?? '');
}

/* ---------------------------------------------------------------------------
 * Values
 * ------------------------------------------------------------------------- */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The dial-code option for this number: one whose text has exactly "+44" (not "+441", not "+4"), preferring
 * the candidate's country among shared codes. Also handles ISO-only option values ("GB").
 */
export function pickDialCodeOptionId(field: ScrapedFieldInput, phone: ParsedPhone): string | null {
    const exactCode = new RegExp(`(^|[^\\d])\\+?\\s?${escape(phone.code)}(?!\\d)`);
    const plusCode = new RegExp(`\\+\\s?${escape(phone.code)}(?!\\d)|\\(\\s*\\+?${escape(phone.code)}\\s*\\)`);
    const text = (o: { label: string; value: string }) => `${o.label} ${o.value}`;

    let candidates = field.options.filter((o) => plusCode.test(text(o)));
    // Options that are just the digits ("44") or values like "44"
    if (!candidates.length) candidates = field.options.filter((o) => exactCode.test(o.value.trim()) || exactCode.test(o.label.trim()));
    // ISO-only options ("GB", "United Kingdom") without any code
    if (!candidates.length) {
        candidates = field.options.filter(
            (o) => norm(o.value) === phone.iso.toLowerCase() || phone.countryNames.includes(norm(o.label))
        );
    }
    if (!candidates.length) return null;

    const isCountry = (o: { label: string; value: string }) => {
        const t = norm(text(o)).replace(/[()+\d]/g, ' ');
        return (
            norm(o.value) === phone.iso.toLowerCase() ||
            phone.countryNames.some((n) => new RegExp(`(^|[^a-z])${escape(n)}([^a-z]|$)`).test(t))
        );
    };
    return (candidates.find(isCountry) ?? candidates[0]).optionId ?? null;
}

/**
 * The country to type into a searchable dial-code picker: the candidate's country when it owns this code,
 * else the code's main country ("United Kingdom" for +44, never Guernsey).
 */
export function phoneCountryName(phone: ParsedPhone, profile: AutofillProfile): string {
    const own = profile.location.country;
    if (own && phone.countryNames.includes(norm(own))) return own;
    return phone.countryNames[0].replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "+44 7911 123456" style, for boxes that take the whole number. */
export function internationalFormat(phone: ParsedPhone): string {
    return `+${phone.code} ${phone.national}`;
}

/**
 * What to type into a phone box. National number when the form has a separate code dropdown, the box is too
 * short for the code, or its placeholder / pattern shows a plain local number; otherwise international.
 */
export function phoneValueFor(field: ScrapedFieldInput & { pattern?: string }, phone: ParsedPhone, formHasCodeField: boolean): string {
    const full = internationalFormat(phone);
    const hint = `${field.placeholder ?? ''} ${field.description ?? ''}`;
    // The box itself asks for the code: "Phone number with country code", "International format"
    const asksForCode = /with\s+(the\s+)?(country|dial(l?ing)?|area)\s+code|incl(\.|uding)?\s+(the\s+)?(country\s+)?code|international/i.test(
        `${field.label ?? ''} ${hint}`
    );
    if (asksForCode && !(field.maxLength !== undefined && field.maxLength < full.length)) return full;
    const wantsNational =
        formHasCodeField ||
        field.type === 'number' ||
        (field.maxLength !== undefined && field.maxLength < full.length) ||
        (!!field.pattern && !/\+/.test(field.pattern)) ||
        (/\d{6,}/.test(hint.replace(/[\s-]/g, '')) && !/\+/.test(hint)) ||
        norm(field.autocomplete).endsWith('tel-national');
    return wantsNational ? phone.national : full;
}

export function phoneFor(profile: AutofillProfile): ParsedPhone | null {
    return parsePhone(profile.phone, profile.location.country);
}
