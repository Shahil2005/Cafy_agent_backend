import { z } from 'zod';

export const linkedinOptimizerInputSchema = z
    .object({
        headline: z.string().max(1000).optional().default(''),
        about: z.string().max(20_000).optional().default(''),
        experience: z.string().max(50_000).optional().default(''),
        education: z.string().max(20_000).optional().default(''),
        skills: z.string().max(10_000).optional().default(''),
        certifications: z.string().max(10_000).optional().default(''),
        projects: z.string().max(20_000).optional().default(''),
        targetRole: z.string().max(200).optional().default(''),
        name: z.string().max(200).optional().default(''),
        profilePhotoUrl: z.string().max(2000).optional().default(''),
        hasProfilePhoto: z.boolean().optional().default(false),
        bannerUrl: z.string().max(2000).optional().default(''),
        hasBanner: z.boolean().optional().default(false),
        resumeText: z.string().max(50_000).optional().default(''),
    })
    .refine(
        (data) => [data.headline, data.about, data.experience, data.education, data.skills].some((v) => v.trim().length > 0),
        { message: 'At least one profile section must contain text' }
    );

export type LinkedinOptimizerInput = z.infer<typeof linkedinOptimizerInputSchema>;
