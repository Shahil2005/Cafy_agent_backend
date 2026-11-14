import fs from 'fs';
import path from 'path';
import { RESOURCE_CATALOG, type ResourceId } from './catalog';

/**
 * Resolve the private PDF directory (not web-public).
 * Works from ts-node (resources/) and compiled dist/resources/.
 */
export function resolveResourcesFilesDir(): string {
    const candidates = [
        path.join(__dirname, 'files'),
        path.join(process.cwd(), 'resources', 'files'),
        path.join(process.cwd(), 'ProductBackend', 'resources', 'files'),
    ];
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                return dir;
            }
        } catch {
            // try next
        }
    }
    return candidates[0];
}

/** Absolute path for a catalogued file, or null if the id/name is unsafe. */
export function resolveResourceAbsolutePath(resourceId: ResourceId): string | null {
    const def = RESOURCE_CATALOG[resourceId];
    if (!def?.fileName) return null;

    const safeName = path.basename(def.fileName);
    if (safeName !== def.fileName || safeName.includes('\0')) {
        return null;
    }

    const dir = path.resolve(resolveResourcesFilesDir());
    const full = path.resolve(dir, safeName);
    if (full !== dir && !full.startsWith(dir + path.sep)) {
        return null;
    }
    return full;
}

export interface ResourceFileInfo {
    absolutePath: string;
    sizeBytes: number;
}

/** Stat a resource file; null if missing or empty. */
export function getResourceFileInfo(resourceId: ResourceId): ResourceFileInfo | null {
    const absolutePath = resolveResourceAbsolutePath(resourceId);
    if (!absolutePath) return null;
    try {
        if (!fs.existsSync(absolutePath)) return null;
        const st = fs.statSync(absolutePath);
        if (!st.isFile() || st.size < 100) return null;
        return { absolutePath, sizeBytes: st.size };
    } catch {
        return null;
    }
}

/** Log missing assets at process start (non-fatal). */
export function warnMissingResourceFiles(): void {
    const missing: string[] = [];
    for (const id of Object.keys(RESOURCE_CATALOG) as ResourceId[]) {
        if (!getResourceFileInfo(id)) {
            missing.push(`${id} (${RESOURCE_CATALOG[id].fileName})`);
        }
    }
    if (missing.length) {
        console.warn('[resources] Missing PDF files on disk:', missing.join(', '));
    }
}
