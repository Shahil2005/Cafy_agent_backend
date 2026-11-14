import type { AgentBlock, JobListCard } from '../contract';

/**
 * A recommendation takes the first numbers on its list, so "job 2" means the second job the user
 * was just shown. The jobs it moved take the empty places, so every other number stays the same.
 */
function withShortlist(list: JobListCard, shortlist: JobListCard): JobListCard {
    const items = [...list.items];
    shortlist.items.forEach((chosen, place) => {
        const from = items.findIndex((job) => job.id === chosen.id);
        if (from < 0) return;
        items[from] = items[place]!;
        items[place] = chosen;
    });
    return { ...list, items, recommendedIds: [...new Set([...(list.recommendedIds ?? []), ...shortlist.items.map((job) => job.id)])] };
}

/** Adds one message's job cards to the recent lists, newest first. Used everywhere numbers are read, so they always agree. */
export function nextJobLists(lists: JobListCard[], blocks: Iterable<AgentBlock>, max = 3): JobListCard[] {
    let next = lists;
    for (const block of blocks) {
        if (block.kind !== 'jobList') continue;
        if (!block.card.pick) {
            next = [block.card, ...next].slice(0, max);
        } else if (block.card.shortlist) {
            const card = block.card;
            const owner = next.findIndex((list) => card.items.every((chosen) => list.items.some((job) => job.id === chosen.id)));
            if (owner >= 0) next = next.map((list, index) => (index === owner ? withShortlist(list, card) : list));
        }
    }
    return next;
}
