import { z } from 'zod';
import { jobInputSchema } from './shared';

export const commEmailInputSchema = z.object({
    emailType: z.string().min(1).max(200),
    tone: z.string().min(1).max(100),
    /** Email UI has no focus selector; default when omitted or empty. */
    focusMode: z
        .string()
        .max(100)
        .default('Balanced')
        .transform((s) => (s.trim() ? s : 'Balanced')),
    extraContext: z.string().max(2000).optional().default(''),
    senderName: z.string().min(1).max(200),
    senderContactInfo: z.string().min(1).max(500),
    candidateData: z.string().max(100_000).optional().default(''),
    job: jobInputSchema,
});

export type CommEmailInput = z.infer<typeof commEmailInputSchema>;
