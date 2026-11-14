import { z } from 'zod';

export const jobInputSchema = z.object({
    role: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    jobDescription: z.string().max(30_000).optional().default(''),
});
