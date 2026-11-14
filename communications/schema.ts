import { z } from 'zod';

export const communicationDocumentTypeSchema = z.enum(['coverletter', 'email']);
export const communicationSourceSchema = z.enum(['web', 'extension']);

export const communicationInputParamsSchema = z.object({
    tone: z.string(),
    focusMode: z.string(),
    extraContext: z.string().optional(),
    coverLetterGoal: z.string().optional(),
    emailType: z.string().optional(),
    senderName: z.string(),
    senderContactInfo: z.string(),
});

export const communicationJobSnapshotSchema = z.object({
    role: z.string(),
    company: z.string(),
    jobDescription: z.string().optional(),
});

export const saveCommunicationMetaSchema = z.object({
    jobId: z.string().max(128).optional(),
    resumeId: z.string().max(128).optional(),
    threadId: z.string().max(256).optional(),
});

export const listCommunicationsQuerySchema = z.object({
    jobId: z.string().max(128).optional(),
    documentType: communicationDocumentTypeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().max(256).optional(),
});

export type CommunicationDocumentType = z.infer<typeof communicationDocumentTypeSchema>;
export type CommunicationSource = z.infer<typeof communicationSourceSchema>;
export type CommunicationInputParams = z.infer<typeof communicationInputParamsSchema>;
export type CommunicationJobSnapshot = z.infer<typeof communicationJobSnapshotSchema>;
export type SaveCommunicationMeta = z.infer<typeof saveCommunicationMetaSchema>;

export interface CommunicationRecord {
    id: string;
    threadId: string;
    version: number;
    isLatest: boolean;
    documentType: CommunicationDocumentType;
    source: CommunicationSource;
    jobId: string | null;
    jobSnapshot: CommunicationJobSnapshot;
    inputParams: CommunicationInputParams;
    resumeId: string | null;
    content: string;
    strategyContent?: string;
    userEdited: boolean;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
}
