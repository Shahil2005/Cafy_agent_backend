import { z } from 'zod';

export const CAREER_RESUME_TEXT_MIN_CHARS = 50;

export const careerAnalysisInputSchema = z.object({
    // No upper character bound by design — resume length is only bounded by the
    // upload file-size limit (2MB) and the Express JSON body limit on this route.
    resumeText: z
        .string()
        .min(CAREER_RESUME_TEXT_MIN_CHARS)
        .optional(),
    filePath: z.string().min(5).optional(),
    resumeName: z.string().min(1).max(255).optional(),
    skipSave: z.boolean().optional(),
    preferences: z.object({
        jobTypes: z.array(z.string()).default([]),
        experienceLevel: z.array(z.string()).default([]),
        sectors: z.array(z.string()).default([]),
        locations: z.array(z.string()).default([]),
        sponsorship: z.string().default('')
    })
}).refine(data => data.resumeText || data.filePath, {
    message: "Either resumeText (for DOCX) or filePath (for PDF) must be provided."
});

export type CareerAnalysisInput = z.infer<typeof careerAnalysisInputSchema>;

export interface SocSalaryRate {
    annual: number | null;
    hourly: number | null;
    pointsOptions?: string[];
}

export interface SocSalaryTable {
    equivalentSoc2010?: string;
    rate100: SocSalaryRate;
    rate90?: SocSalaryRate;
    rate80?: SocSalaryRate;
    rate70?: SocSalaryRate;
    source: string;
}

export interface SocNationalPayScaleEntry {
    title: string;
    rawText: string;
    source: string;
}

export interface SocOccupationData {
    skillLevel: string | null;
    expandedJobTitles: string[] | null;
    sponsorship: {
        skilledWorkerEligible: boolean;
        phdEligible: boolean | null;
        routes: { skilledWorker: boolean; globalBusinessMobility: boolean; scaleUp: boolean } | null;
        immigrationSalaryList: { criteria: string; nations: Record<string, boolean>; removalDate: string }[] | null;
        applicantStatus: 'open_to_new_applicants' | 'legacy_only_existing_visa_holders' | 'not_eligible';
    };
    salary: {
        type: 'going_rate' | 'national_pay_scale' | 'not_eligible';
        currency: string;
        median: SocSalaryTable | null;
        percentile25: SocSalaryTable | null;
        nationalPayScale: {
            byNation: Record<string, SocNationalPayScaleEntry>;
            payBandReference: { table: string; data: Record<string, Record<string, string>> } | null;
            teacherPayReference: { table: string; data: Record<string, Record<string, string>> } | null;
        } | null;
    };
}

export interface CareerRecommendation {
    socCode: string;
    // officialTitle/category/socData are populated by enrichWithSocData() from
    // uk_soc_master.json after the AI returns socCode - the AI never generates them.
    officialTitle: string;
    category: string;
    reason: string;
    availableInResume: string[];
    neededOrSuggested: string[];
    matchedSubRoles: string[];
    socData?: SocOccupationData;
}

export interface CareerAnalysisResult {
    userId: string;
    uploadedAt: string;
    resumeName: string;
    resumeText?: string;
    sponsorshipEmployability: 'good' | 'fair' | 'low';
    employabilityFeedback: string;
    recommendations: CareerRecommendation[];
}
