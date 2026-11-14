import { z } from 'zod';
import { jobInputSchema } from './shared';

export const commCoverLetterInputSchema = z.object({
    tone: z.string().min(1).max(100),
    focusMode: z.string().min(1).max(100),
    extraContext: z.string().max(2000).optional().default(''),
    coverLetterGoal: z.string().min(1).max(200),
    senderName: z.string().min(1).max(200),
    senderContactInfo: z.string().min(1).max(500),
    candidateData: z.string().max(100_000),
    job: jobInputSchema,
});

export type CommCoverLetterInput = z.infer<typeof commCoverLetterInputSchema>;
