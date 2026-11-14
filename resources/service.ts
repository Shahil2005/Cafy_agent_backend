import * as admin from 'firebase-admin';
import { RESOURCE_CATALOG, type ResourceId } from './catalog';

export interface ResourceStats {
    resourceId: ResourceId;
    title: string;
    fileName: string;
    downloadCount: number;
    uniqueDownloaderCount: number;
}

function metricsRef(resourceId: ResourceId) {
    return admin.firestore().doc(`resourceMetrics/${resourceId}`);
}

function downloaderRef(resourceId: ResourceId, uid: string) {
    return metricsRef(resourceId).collection('downloaders').doc(uid);
}

export async function recordResourceDownload(params: {
    resourceId: ResourceId;
    uid: string;
    email?: string | null;
}): Promise<ResourceStats> {
    const { resourceId, uid, email } = params;
    if (!uid || typeof uid !== 'string') {
        throw new Error('INVALID_UID');
    }

    const catalog = RESOURCE_CATALOG[resourceId];
    const metricDoc = metricsRef(resourceId);
    const userDoc = downloaderRef(resourceId, uid);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const result = await admin.firestore().runTransaction(async (tx) => {
        const [metricSnap, userSnap] = await Promise.all([
            tx.get(metricDoc),
            tx.get(userDoc),
        ]);

        const isNewDownloader = !userSnap.exists;
        const prevCount = metricSnap.exists
            ? Number(metricSnap.data()?.downloadCount || 0)
            : 0;
        const prevUnique = metricSnap.exists
            ? Number(metricSnap.data()?.uniqueDownloaderCount || 0)
            : 0;

        const downloadCount = prevCount + 1;
        const uniqueDownloaderCount = isNewDownloader ? prevUnique + 1 : prevUnique;

        tx.set(
            metricDoc,
            {
                resourceId,
                title: catalog.title,
                fileName: catalog.fileName,
                downloadCount,
                uniqueDownloaderCount,
                updatedAt: now,
                createdAt: metricSnap.exists
                    ? (metricSnap.data()?.createdAt ?? now)
                    : now,
            },
            { merge: true }
        );

        const prevUserCount = userSnap.exists
            ? Number(userSnap.data()?.count || 0)
            : 0;
        tx.set(
            userDoc,
            {
                uid,
                email: email ?? null,
                count: prevUserCount + 1,
                firstDownloadedAt: userSnap.exists
                    ? (userSnap.data()?.firstDownloadedAt ?? now)
                    : now,
                lastDownloadedAt: now,
            },
            { merge: true }
        );

        return {
            resourceId,
            title: catalog.title,
            fileName: catalog.fileName,
            downloadCount,
            uniqueDownloaderCount,
        };
    });

    return result;
}

export async function getResourceStats(resourceId: ResourceId): Promise<ResourceStats> {
    const catalog = RESOURCE_CATALOG[resourceId];
    const snap = await metricsRef(resourceId).get();
    const data = snap.data() || {};
    return {
        resourceId,
        title: catalog.title,
        fileName: catalog.fileName,
        downloadCount: Number(data.downloadCount || 0),
        uniqueDownloaderCount: Number(data.uniqueDownloaderCount || 0),
    };
}

export async function listResourceStats(): Promise<ResourceStats[]> {
    const ids = Object.keys(RESOURCE_CATALOG) as ResourceId[];
    return Promise.all(ids.map((id) => getResourceStats(id)));
}
