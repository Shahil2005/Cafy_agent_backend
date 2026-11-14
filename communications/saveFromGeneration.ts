import type { CommCoverLetterInput } from '../ai/schemas/commCoverLetter';
import type { CommEmailInput } from '../ai/schemas/commEmail';
import type { CommunicationSource, SaveCommunicationMeta } from './schema';
import { extractGeminiText, saveCommunication } from './service';

type CommInput = CommCoverLetterInput | CommEmailInput;

export async function saveCommunicationFromGeneration(params: {
    userId: string;
    operation: 'comm_cover_letter' | 'comm_email';
    input: CommInput;
    responseBody: unknown;
    source: CommunicationSource;
    meta?: SaveCommunicationMeta;
}): Promise<{ commId: string; threadId: string; version: number } | null> {
    const rawText = extractGeminiText(params.responseBody);
    if (!rawText) return null;

    const documentType = params.operation === 'comm_cover_letter' ? 'coverletter' : 'email';
    const input = params.input;

    const inputParams = {
        tone: input.tone,
        focusMode: input.focusMode,
        senderName: input.senderName,
        senderContactInfo: input.senderContactInfo,
        ...(input.extraContext ? { extraContext: input.extraContext } : {}),
        ...(params.operation === 'comm_cover_letter'
            ? { coverLetterGoal: (input as CommCoverLetterInput).coverLetterGoal }
            : { emailType: (input as CommEmailInput).emailType }),
    };

    return saveCommunication({
        userId: params.userId,
        documentType,
        source: params.source,
        rawText,
        job: {
            role: input.job.role,
            company: input.job.company,
            jobDescription: input.job.jobDescription,
        },
        inputParams,
        meta: params.meta,
    });
}
