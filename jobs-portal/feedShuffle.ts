import { createHash } from 'crypto';

/** Stable sort key — same seed + id always yields the same position. */
export function shuffleKey(id: string | number, seed: string): string {
    return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

export function sortIdsBySeed(ids: string[], seed: string): string[] {
    return [...ids].sort((a, b) => shuffleKey(a, seed).localeCompare(shuffleKey(b, seed)));
}

export function buildShuffledBrowseOrder(
    preferredIds: string[],
    remainderIds: string[],
    seed: string,
    secondaryIds: string[] = [],
    levelOnlyIds: string[] = []
): string[] {
    const shuffledPreferred = sortIdsBySeed(preferredIds, seed);
    const shuffledSecondary = sortIdsBySeed(secondaryIds, `${seed}:secondary`);
    const shuffledLevelOnly = sortIdsBySeed(levelOnlyIds, `${seed}:levelOnly`);
    const shuffledRemainder = sortIdsBySeed(remainderIds, `${seed}:remainder`);
    return [
        ...shuffledPreferred,
        ...shuffledSecondary,
        ...shuffledLevelOnly,
        ...shuffledRemainder,
    ];
}
