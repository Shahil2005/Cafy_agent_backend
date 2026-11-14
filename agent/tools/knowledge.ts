import { z } from 'zod';
import type { OfficialSourcesCard } from '../contract';
import type { EmbedFn } from '../cv/embed';
import { loadShards, officialQuestion, searchKnowledge, withDateStatus, withFigureSections, type KnowledgeShard } from '../knowledge/govuk';
import { defineTool, type AgentTool } from './types';

/** Official GOV.UK guidance (visas, work rights, starting work), answered with citations. */
export function createKnowledgeTools(deps: { shards?: () => KnowledgeShard[]; embed?: EmbedFn } = {}): AgentTool[] {
    const guidance = defineTool({
        name: 'gov_uk_guidance',
        description:
            'Searches official GOV.UK guidance (all UK work visas and their rules, sponsorship, settlement; work rights such as minimum wage, holiday, contracts, notice, discrimination, right to work; starting work: National Insurance, tax codes, P45, student loan repayment, apprenticeships). Use for any rule or process question; answer only from the passages and cite them.',
        args: z
            .object({
                question: z.string().trim().min(3).max(300),
                topic: z.enum(['work-visas', 'work-rights', 'starting-work']).optional(),
            })
            .strict(),
        label: () => 'Checking official GOV.UK guidance',
        async run(args, ctx) {
            const shards = (deps.shards ?? loadShards)();
            if (!shards.length) return { error: 'KNOWLEDGE_UNAVAILABLE', instruction: 'Say the official guidance is unavailable right now and link https://www.gov.uk.' };
            const question = officialQuestion(args.question);
            let hits = await searchKnowledge(question, { shards, embed: deps.embed, topics: args.topic ? [args.topic] : undefined });
            // A wrong topic guess must not hide the answer: retry across everything.
            if (args.topic && !hits.length) hits = await searchKnowledge(question, { shards, embed: deps.embed });
            hits = withFigureSections(hits, `${args.question} ${ctx.userMessage ?? ''}`, shards);
            if (!hits.length) return { found: false, instruction: 'Nothing relevant was found in the official guidance. Say so and link https://www.gov.uk.' };
            const card: OfficialSourcesCard = {
                items: hits.map((h) => ({
                    title: h.title,
                    section: h.section,
                    url: h.url,
                    checked: h.fetchedAt.slice(0, 10),
                    ...(h.updatedAt ? { updated: h.updatedAt.slice(0, 10) } : {}),
                    ...(h.stale ? { stale: true } : {}),
                })),
            };
            ctx.emit('official-sources', { kind: 'officialSources', card });
            return {
                found: true,
                passages: hits.map((h, i) => ({ ref: i + 1, page: h.title, section: h.section, url: h.url, text: withDateStatus(h.text.slice(0, 1800)), ...(h.stale ? { mayBeOutOfDate: true } : {}) })),
                instruction:
                    'Answer only from these official passages, in plain English. Each date is tagged [passed] or [to come] by code: a rule from a [passed] date is the rule now, so say it applies now, never that it will apply. Never copy the tags. A passage about one group, such as agency workers, covers only that group: never use it to limit a rule for everyone. Start with what the rule in force today allows, and do not start with "Yes" if it closes the path they asked about. Mention the page names you used. When the passages give figures for the question (rates, fees, limits, dates), state them exactly with who each one applies to, and use the latest ones in force today. Do not ask for details such as age instead of giving the figures; show each case. If they do not cover the question, call gov_uk_guidance once more using GOV.UK\'s own words for the topic (such as "National Minimum Wage rates"); if they still do not cover it, say so. Never say whether this person is or is not eligible; explain the rule and say to check GOV.UK or a regulated adviser.',
            };
        },
    });
    return [guidance];
}

export const KNOWLEDGE_TOOLS = createKnowledgeTools();
