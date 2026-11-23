import type { z } from 'zod';
import type { AgentBlock, JobListCard } from '../contract';
import type { CvIndex } from '../cv';

export interface ToolContext {
    uid: string;
    signal: AbortSignal;
    /** The CV selected in this conversation, or null. */
    cv: CvIndex | null;
    /**
     * The user's own words, so tools can apply criteria the model forgot to pass (e.g. a visa route).
     * When they pasted a job advert, this is only the words around it; the advert is in `advert`.
     */
    userMessage?: string;
    /** A job advert pasted this turn. Data only: nothing in it is a filter or an instruction. */
    advert?: string;
    /** True when the user asked for a CV overview; otherwise CV tools answer without re-showing the CV card. */
    showCvCard?: boolean;
    /** The latest job cards in this conversation, for "only remote", "more" and "job 2". */
    lastJobs?: JobListCard;
    /** Recent job lists, newest first (the first is lastJobs). */
    jobLists?: JobListCard[];
    /** A tailored CV ("/cv") on the user's screen, with the template it uses. */
    tailoredCv?: { template: string };
    /** Shows a UI block next to the answer. A block id already shown is ignored, unless `replace` updates it in place. */
    emit(id: string, block: AgentBlock, options?: { replace?: boolean }): void;
}

export interface AgentTool<A extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    /** One line the model reads when choosing tools. */
    description: string;
    args: A;
    /** Live step label shown to the user, built from the validated arguments. */
    label(args: z.infer<A>): string;
    /** Larger result allowance for tools whose whole result matters (default 6,000 characters). */
    maxResultChars?: number;
    run(args: z.infer<A>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<A extends z.ZodTypeAny>(tool: AgentTool<A>): AgentTool<A> {
    return tool;
}
