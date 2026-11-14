/**
 * Native JSON shape retained for default/legacy web-discovery callers.
 * Production's explicit extraction phase uses plain URL Context with short
 * source IDs and enforces its strict contract in chatGoogleDiscovery instead.
 * Semantic validation still belongs to chatGoogleDiscovery: JSON schema does not
 * establish availability, sponsorship, suitability or source truth.
 * https://ai.google.dev/gemini-api/docs/generate-content/structured-output
 */
const text = (description: string) => ({ type: 'string', description });
const optionalText = (description: string) => ({
    type: ['string', 'null'],
    description,
});

export const WEB_DISCOVERY_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        cards: {
            type: 'array',
            minItems: 0,
            maxItems: 2,
            description:
                'Up to two source-supported individual advertisements meeting the request. Empty when no reliable adverts are found.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title: text('Literal headline of the individual vacancy.'),
                    employer: text('The recruiting employer named in the advert.'),
                    location: text('The advertised work location, without guessing.'),
                    salary: optionalText('Salary exactly as advertised; null when absent.'),
                    employmentType: optionalText('Advertised employment type; null when absent.'),
                    workingArrangement: {
                        type: ['string', 'null'],
                        enum: ['remote', 'hybrid', 'on-site', null],
                        description: 'Explicit advertised arrangement; null when unspecified.',
                    },
                    description: text('Concise source-attributed summary of the actual advertised work.'),
                    closingDate: optionalText('Explicit application deadline as YYYY-MM-DD, or null. Never invent a date.'),
                    postedDate: optionalText('Explicit posting date as YYYY-MM-DD, or null. Never use the retrieval date.'),
                    url: text('Exact public HTTPS individual-advert URL successfully retrieved by URL Context in this request. If the supplied source is an original native Google grounding link for that advert, retain that exact retrieved link; never guess its canonical destination.'),
                    explanation: text('Which requested criteria the advert establishes and which details still need checking. No personal-fit or guaranteed-availability claim.'),
                },
                required: [
                    'title',
                    'employer',
                    'location',
                    'salary',
                    'employmentType',
                    'workingArrangement',
                    'description',
                    'closingDate',
                    'postedDate',
                    'url',
                    'explanation',
                ],
            },
        },
    },
    required: ['cards'],
};

