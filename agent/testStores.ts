/* eslint-disable @typescript-eslint/no-explicit-any */
/** In-memory stand-ins so handler tests never touch Firebase. */
export function memoryStores() {
    const convs = new Map<string, any>();
    const cvs = new Map<string, any>();
    return {
        convs,
        cvs,
        conversations: {
            get: async (_uid: string, id: string) => convs.get(id) ?? null,
            put: async (_uid: string, c: any) => { convs.set(c.id, JSON.parse(JSON.stringify(c))); },
            list: async () => [...convs.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
            remove: async (_uid: string, id: string) => { convs.delete(id); },
        },
        cvStore: {
            get: async (_uid: string, hash: string) => cvs.get(hash) ?? null,
            put: async (_uid: string, index: any) => { cvs.set(index.hash, index); },
        },
    };
}
