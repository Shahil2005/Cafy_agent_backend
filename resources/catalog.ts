export type ResourceId =
    | 'uk-nhs-organisations-directory'
    | 'uk-council-careers-directory'
    | 'uk-manufacturing-companies-directory'
    | 'uk-automobile-companies-directory'
    | 'uk-finance-money-capital-companies-directory'
    | 'uk-football-clubs-directory'
    | 'uk-technology-engineering-companies-directory'
    | 'uk-supply-chain-employers-directory'
    | 'uk-electronics-employers-directory';

export type ResourceCategoryId =
    | 'nhs'
    | 'council'
    | 'manufacturing'
    | 'automobile'
    | 'finance'
    | 'football'
    | 'technology'
    | 'supply-chain'
    | 'electronics';

export interface ResourceDefinition {
    id: ResourceId;
    categoryId: ResourceCategoryId;
    title: string;
    description: string;
    /** Filename under ProductBackend/resources/files/ (served only via authenticated API). */
    fileName: string;
    format: 'PDF';
    /** Exact byte size of the hosted file (keep in sync when replacing the asset). */
    fileSizeBytes: number;
    /** Short label shown in the UI, e.g. "UK · NHS" */
    badge: string;
    highlights: string[];
}

/** Public download count starts at this baseline and increments from there. */
export const DISPLAY_DOWNLOAD_BASE = 72;

export function toDisplayDownloadCount(rawCount: number): number {
    return DISPLAY_DOWNLOAD_BASE + Math.max(0, Number(rawCount) || 0);
}

export interface ResourceCategoryDefinition {
    id: ResourceCategoryId;
    label: string;
    status: 'available' | 'coming_soon';
    title: string;
    description: string;
    badge: string;
    highlights: string[];
    /** Linked downloadable resource when status is available */
    resourceId: ResourceId | null;
}

/** Appended to every category/resource description shown in the Resources UI. */
export const SPONSORED_LIST_DESCRIPTION_SUFFIX =
    ' Every organisation listed here is sourced from the official **UK sponsored** employers register.';

/** Display order: available directories first */
export const RESOURCE_CATEGORIES: ResourceCategoryDefinition[] = [
    {
        id: 'council',
        label: 'Council',
        status: 'available',
        title: 'UK Council Careers Directory',
        description:
            'A curated directory of UK councils and local authorities to help you research public-sector employers and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Council',
        highlights: [
            'Local authority employer lists',
            'Useful for public-sector applications',
            'Organised for career research',
        ],
        resourceId: 'uk-council-careers-directory',
    },
    {
        id: 'nhs',
        label: 'NHS',
        status: 'available',
        title: 'UK NHS Organisations Directory',
        description:
            'A curated directory of UK NHS organisations to help you research employers, target applications, and plan your healthcare career path.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · NHS',
        highlights: [
            'Organised for career research',
            'Useful for applications & outreach',
            'Updated for Cafy users',
        ],
        resourceId: 'uk-nhs-organisations-directory',
    },
    {
        id: 'manufacturing',
        label: 'Manufacturing',
        status: 'available',
        title: 'UK Manufacturing Companies Directory',
        description:
            'A curated directory of UK manufacturing employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Manufacturing',
        highlights: [
            'Manufacturing employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-manufacturing-companies-directory',
    },
    {
        id: 'automobile',
        label: 'Automobile',
        status: 'available',
        title: 'UK Automobile Companies Directory',
        description:
            'A curated directory of UK automotive employers to help you research OEMs, suppliers, and related opportunities.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Automobile',
        highlights: [
            'Automotive employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-automobile-companies-directory',
    },
    {
        id: 'finance',
        label: 'Finance',
        status: 'available',
        title: 'UK Finance, Money & Capital Companies Directory',
        description:
            'A curated directory of UK finance, banking, and capital-markets employers to help you research companies and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Finance',
        highlights: [
            'Finance & capital markets employers',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-finance-money-capital-companies-directory',
    },
    {
        id: 'football',
        label: 'Football',
        status: 'available',
        title: 'UK Football Clubs Directory',
        description:
            'A curated directory of UK football clubs to help you research employers and target applications in the football industry.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Football',
        highlights: [
            'Football club employer lists',
            'Useful for applications & outreach',
            'Organised for career research',
        ],
        resourceId: 'uk-football-clubs-directory',
    },
    {
        id: 'technology',
        label: 'Technology',
        status: 'available',
        title: 'UK Technology & Engineering Companies Directory',
        description:
            'A curated directory of UK technology and engineering employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Technology',
        highlights: [
            'Tech & engineering employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-technology-engineering-companies-directory',
    },
    {
        id: 'supply-chain',
        label: 'Supply Chain',
        status: 'available',
        title: 'UK Supply Chain Employers Directory',
        description:
            'A curated directory of UK supply-chain and logistics employers to help you research companies and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Supply Chain',
        highlights: [
            'Logistics & supply-chain employers',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-supply-chain-employers-directory',
    },
    {
        id: 'electronics',
        label: 'Electronics',
        status: 'available',
        title: 'UK Electronics Employers Directory',
        description:
            'A curated directory of UK electronics employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        badge: 'UK · Electronics',
        highlights: [
            'Electronics employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
        resourceId: 'uk-electronics-employers-directory',
    },
];

export const RESOURCE_CATALOG: Record<ResourceId, ResourceDefinition> = {
    'uk-nhs-organisations-directory': {
        id: 'uk-nhs-organisations-directory',
        categoryId: 'nhs',
        title: 'UK NHS Organisations Directory',
        description:
            'A curated directory of UK NHS organisations to help you research employers, target applications, and plan your healthcare career path.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_NHS_Organisations_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 186385,
        badge: 'UK · NHS',
        highlights: [
            'Organised for career research',
            'Useful for applications & outreach',
            'Updated for Cafy users',
        ],
    },
    'uk-council-careers-directory': {
        id: 'uk-council-careers-directory',
        categoryId: 'council',
        title: 'UK Council Careers Directory',
        description:
            'A curated directory of UK councils and local authorities to help you research public-sector employers and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Council_Careers_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 189591,
        badge: 'UK · Council',
        highlights: [
            'Local authority employer lists',
            'Useful for public-sector applications',
            'Organised for career research',
        ],
    },
    'uk-manufacturing-companies-directory': {
        id: 'uk-manufacturing-companies-directory',
        categoryId: 'manufacturing',
        title: 'UK Manufacturing Companies Directory',
        description:
            'A curated directory of UK manufacturing employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Manufacturing_Companies_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 198594,
        badge: 'UK · Manufacturing',
        highlights: [
            'Manufacturing employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
    'uk-automobile-companies-directory': {
        id: 'uk-automobile-companies-directory',
        categoryId: 'automobile',
        title: 'UK Automobile Companies Directory',
        description:
            'A curated directory of UK automotive employers to help you research OEMs, suppliers, and related opportunities.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Automobile_Companies_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 179059,
        badge: 'UK · Automobile',
        highlights: [
            'Automotive employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
    'uk-finance-money-capital-companies-directory': {
        id: 'uk-finance-money-capital-companies-directory',
        categoryId: 'finance',
        title: 'UK Finance, Money & Capital Companies Directory',
        description:
            'A curated directory of UK finance, banking, and capital-markets employers to help you research companies and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Finance_Money_Capital_Companies_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 193329,
        badge: 'UK · Finance',
        highlights: [
            'Finance & capital markets employers',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
    'uk-football-clubs-directory': {
        id: 'uk-football-clubs-directory',
        categoryId: 'football',
        title: 'UK Football Clubs Directory',
        description:
            'A curated directory of UK football clubs to help you research employers and target applications in the football industry.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Football_Clubs_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 189177,
        badge: 'UK · Football',
        highlights: [
            'Football club employer lists',
            'Useful for applications & outreach',
            'Organised for career research',
        ],
    },
    'uk-technology-engineering-companies-directory': {
        id: 'uk-technology-engineering-companies-directory',
        categoryId: 'technology',
        title: 'UK Technology & Engineering Companies Directory',
        description:
            'A curated directory of UK technology and engineering employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Technology_Engineering_Companies_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 191666,
        badge: 'UK · Technology',
        highlights: [
            'Tech & engineering employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
    'uk-supply-chain-employers-directory': {
        id: 'uk-supply-chain-employers-directory',
        categoryId: 'supply-chain',
        title: 'UK Supply Chain Employers Directory',
        description:
            'A curated directory of UK supply-chain and logistics employers to help you research companies and target applications.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Supply_Chain_Employers_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 179138,
        badge: 'UK · Supply Chain',
        highlights: [
            'Logistics & supply-chain employers',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
    'uk-electronics-employers-directory': {
        id: 'uk-electronics-employers-directory',
        categoryId: 'electronics',
        title: 'UK Electronics Employers Directory',
        description:
            'A curated directory of UK electronics employers to help you research companies, target applications, and plan your next move.' +
            SPONSORED_LIST_DESCRIPTION_SUFFIX,
        fileName: 'Cafy_Careers_UK_Electronics_Employers_Directory.pdf',
        format: 'PDF',
        fileSizeBytes: 190322,
        badge: 'UK · Electronics',
        highlights: [
            'Electronics employer research',
            'Useful for applications & outreach',
            'Organised for career targeting',
        ],
    },
};

export function isResourceId(value: unknown): value is ResourceId {
    return typeof value === 'string' && value in RESOURCE_CATALOG;
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
