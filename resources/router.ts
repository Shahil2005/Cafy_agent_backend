import fs from 'fs';
import { Router, Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { captureServerError } from '../lib/observability/sentry';
import { isIrelandCatalogProfile } from '../jobs-portal/partTimeAccess';
import {
    formatFileSize,
    isResourceId,
    RESOURCE_CATALOG,
    RESOURCE_CATEGORIES,
    toDisplayDownloadCount,
    type ResourceId,
} from './catalog';
import { getResourceFileInfo, warnMissingResourceFiles } from './files';
import {
    getResourceStats,
    listResourceStats,
    recordResourceDownload,
} from './service';

type VerifyToken = (req: Request, res: Response, next: () => void) => Promise<void | Response>;

type AuthedRequest = Request & {
    user: { uid: string; email?: string | null };
};

/** True when the response was already sent. Country comes from Firestore, never the request. */
async function denyUnlessUkCatalog(req: Request, res: Response): Promise<boolean> {
    const userId = (req as AuthedRequest).user?.uid;
    if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return true;
    }

    const snap = await admin.firestore().doc(`users/${userId}`).get();
    if (isIrelandCatalogProfile(snap.data())) {
        res.status(403).json({
            error: 'RESOURCES_UK_ONLY',
            message: 'Resources are available for United Kingdom profiles.',
        });
        return true;
    }

    return false;
}

warnMissingResourceFiles();

function reportResourcesError(route: string, error: unknown): void {
    console.error(`[resources] ${route} error:`, error);
    captureServerError(error, { tags: { feature: 'resources', route } });
}

function isResourcePubliclyAvailable(resourceId: ResourceId): boolean {
    return RESOURCE_CATEGORIES.some(
        (c) => c.status === 'available' && c.resourceId === resourceId
    );
}

function serializeResource(
    id: ResourceId,
    stats?: { downloadCount: number; uniqueDownloaderCount: number }
) {
    const r = RESOURCE_CATALOG[id];
    const file = getResourceFileInfo(id);
    const fileSizeBytes = file?.sizeBytes ?? r.fileSizeBytes;
    return {
        id: r.id,
        categoryId: r.categoryId,
        title: r.title,
        description: r.description,
        fileName: r.fileName,
        format: r.format,
        fileSizeBytes,
        fileSizeLabel: formatFileSize(fileSizeBytes),
        badge: r.badge,
        highlights: r.highlights,
        /** Authenticated file endpoint — never a public static path. */
        downloadPath: `/api/resources/${encodeURIComponent(id)}/file`,
        fileReady: Boolean(file),
        downloadCount: toDisplayDownloadCount(stats?.downloadCount ?? 0),
        uniqueDownloaderCount: stats?.uniqueDownloaderCount ?? 0,
    };
}

function sendResourcePdf(
    req: Request,
    res: Response,
    resourceId: ResourceId,
    disposition: 'inline' | 'attachment'
): void {
    if (!isResourcePubliclyAvailable(resourceId)) {
        res.status(404).json({
            error: 'RESOURCE_UNAVAILABLE',
            message: 'That resource is not available yet.',
        });
        return;
    }

    const file = getResourceFileInfo(resourceId);
    if (!file) {
        res.status(503).json({
            error: 'RESOURCE_FILE_MISSING',
            message: 'This file is temporarily unavailable. Please try again later.',
        });
        return;
    }

    const catalog = RESOURCE_CATALOG[resourceId];
    const safeFileName = catalog.fileName.replace(/[\r\n"]/g, '');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    const stream = fs.createReadStream(file.absolutePath);
    stream.on('error', (err) => {
        reportResourcesError('file-stream', err);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'RESOURCE_FILE_READ_FAILED',
                message: 'Could not read this file. Please try again.',
            });
        } else {
            res.destroy();
        }
    });
    stream.pipe(res);
}

export function createResourcesRouter(
    verifyToken: VerifyToken,
    downloadLimiter?: (req: Request, res: Response, next: () => void) => void
): Router {
    const router = Router();
    const fileGuards = [verifyToken, ...(downloadLimiter ? [downloadLimiter] : [])];

    router.get('/', verifyToken, async (req: Request, res: Response) => {
        try {
            if (await denyUnlessUkCatalog(req, res)) return;
            const stats = await listResourceStats();
            const byId = Object.fromEntries(stats.map((s) => [s.resourceId, s]));
            const resources = (Object.keys(RESOURCE_CATALOG) as ResourceId[])
                .filter((id) => isResourcePubliclyAvailable(id))
                .map((id) => serializeResource(id, byId[id]));
            const categories = RESOURCE_CATEGORIES.map((category) => {
                const linked =
                    category.resourceId != null ? byId[category.resourceId] : undefined;
                return {
                    id: category.id,
                    label: category.label,
                    status: category.status,
                    title: category.title,
                    description: category.description,
                    badge: category.badge,
                    highlights: category.highlights,
                    resourceId: category.resourceId,
                    downloadCount: toDisplayDownloadCount(linked?.downloadCount ?? 0),
                    uniqueDownloaderCount: linked?.uniqueDownloaderCount ?? 0,
                };
            });
            res.setHeader('Cache-Control', 'private, max-age=30');
            return res.json({ categories, resources });
        } catch (err) {
            reportResourcesError('list', err);
            return res.status(500).json({
                error: 'RESOURCES_LIST_FAILED',
                message: 'Could not load resources. Please try again.',
            });
        }
    });

    router.get('/:resourceId/stats', verifyToken, async (req: Request, res: Response) => {
        try {
            if (await denyUnlessUkCatalog(req, res)) return;
            const { resourceId } = req.params;
            if (!isResourceId(resourceId)) {
                return res.status(404).json({
                    error: 'RESOURCE_NOT_FOUND',
                    message: 'That resource does not exist.',
                });
            }
            const stats = await getResourceStats(resourceId);
            res.setHeader('Cache-Control', 'private, max-age=15');
            return res.json(stats);
        } catch (err) {
            reportResourcesError('stats', err);
            return res.status(500).json({
                error: 'RESOURCES_STATS_FAILED',
                message: 'Could not load download stats.',
            });
        }
    });

    /** Authenticated PDF stream for preview (inline) or download (attachment). */
    router.get(`/:resourceId/file`, ...fileGuards, async (req: Request, res: Response) => {
        try {
            if (await denyUnlessUkCatalog(req, res)) return;
            const { resourceId } = req.params;
            if (!isResourceId(resourceId)) {
                return res.status(404).json({
                    error: 'RESOURCE_NOT_FOUND',
                    message: 'That resource does not exist.',
                });
            }
            const raw = String(req.query.disposition || 'inline').toLowerCase();
            const disposition = raw === 'attachment' ? 'attachment' : 'inline';
            return sendResourcePdf(req, res, resourceId, disposition);
        } catch (err) {
            reportResourcesError('file', err);
            return res.status(500).json({
                error: 'RESOURCE_FILE_FAILED',
                message: 'Could not serve this file. Please try again.',
            });
        }
    });

    const downloadHandlers = [
        verifyToken,
        ...(downloadLimiter ? [downloadLimiter] : []),
        async (req: Request, res: Response) => {
            try {
                if (await denyUnlessUkCatalog(req, res)) return;
                const { resourceId } = req.params;
                if (!isResourceId(resourceId)) {
                    return res.status(404).json({
                        error: 'RESOURCE_NOT_FOUND',
                        message: 'That resource does not exist.',
                    });
                }

                if (!isResourcePubliclyAvailable(resourceId)) {
                    return res.status(404).json({
                        error: 'RESOURCE_UNAVAILABLE',
                        message: 'That resource is not available yet.',
                    });
                }

                if (!getResourceFileInfo(resourceId)) {
                    return res.status(503).json({
                        error: 'RESOURCE_FILE_MISSING',
                        message: 'This file is temporarily unavailable. Please try again later.',
                    });
                }

                const user = (req as AuthedRequest).user;
                if (!user?.uid) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }

                const stats = await recordResourceDownload({
                    resourceId,
                    uid: user.uid,
                    email: user.email ?? null,
                });
                const body = serializeResource(resourceId, stats);
                return res.json({
                    ok: true,
                    ...body,
                });
            } catch (err) {
                reportResourcesError('download', err);
                return res.status(500).json({
                    error: 'RESOURCES_DOWNLOAD_TRACK_FAILED',
                    message: 'Could not record this download. Please try again.',
                });
            }
        },
    ];

    router.post('/:resourceId/download', ...downloadHandlers);

    return router;
}
