import { z } from 'zod';
import { CV_TOOLS } from './cv';
import { UK_TOOLS } from './uk';
import { SPONSOR_TOOLS } from './sponsors';
import { KNOWLEDGE_TOOLS } from './knowledge';
import { JOB_TOOLS } from './jobs';
import { INSIGHT_TOOLS } from './insights';
import { defineTool, type AgentTool } from './types';

export { defineTool, type AgentTool, type ToolContext } from './types';

/** UK date for deadlines and "how long ago" questions; real CV, job and UK tools register here in later phases. */
const ukDateTool = defineTool({
    name: 'get_uk_date',
    description: 'Returns today\'s date and time in the UK. Use for deadlines, ages or "how long ago" questions.',
    args: z.object({}).strict(),
    label: () => 'Checking today\'s date',
    async run() {
        const now = new Date();
        return {
            date: now.toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
            time: now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
        };
    },
});

export const AGENT_TOOLS: AgentTool[] = [ukDateTool, ...CV_TOOLS, ...UK_TOOLS, ...SPONSOR_TOOLS, ...KNOWLEDGE_TOOLS, ...JOB_TOOLS, ...INSIGHT_TOOLS];

export function findTool(name: string, tools: AgentTool[] = AGENT_TOOLS): AgentTool | undefined {
    return tools.find((tool) => tool.name === name);
}

/** Compact catalogue for the system prompt: name, purpose and argument keys only. */
export function describeTools(tools: AgentTool[] = AGENT_TOOLS): string {
    return tools
        .map((tool) => {
            const shape = tool.args instanceof z.ZodObject ? Object.keys(tool.args.shape) : [];
            return `- ${tool.name}(${shape.join(', ')}): ${tool.description}`;
        })
        .join('\n');
}
