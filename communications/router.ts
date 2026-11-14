import { Router, Request, Response } from 'express';
import { listCommunicationsQuerySchema } from './schema';
import { deleteCommunication, getCommunication, listCommunications } from './service';

type VerifyToken = (req: Request, res: Response, next: () => void) => Promise<void | Response>;

export function createCommunicationsRouter(verifyToken: VerifyToken): Router {
    const router = Router();

    router.get('/', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as Request & { user: { uid: string } }).user.uid;
            const parsed = listCommunicationsQuerySchema.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'INVALID_QUERY',
                    message: 'Invalid query parameters',
                    details: parsed.error.flatten(),
                });
            }

            const { jobId, documentType, limit, cursor } = parsed.data;
            const result = await listCommunications(uid, { jobId, documentType, limit, cursor });
            return res.status(200).json(result);
        } catch (error) {
            console.error('[communications] list error:', error);
            return res.status(500).json({ error: 'Failed to list communications' });
        }
    });

    router.get('/:id', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as Request & { user: { uid: string } }).user.uid;
            const record = await getCommunication(uid, req.params.id);
            if (!record) {
                return res.status(404).json({ error: 'NOT_FOUND', message: 'Communication not found' });
            }
            return res.status(200).json(record);
        } catch (error) {
            console.error('[communications] get error:', error);
            return res.status(500).json({ error: 'Failed to fetch communication' });
        }
    });

    router.delete('/:id', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as Request & { user: { uid: string } }).user.uid;
            const deleted = await deleteCommunication(uid, req.params.id);
            if (!deleted) {
                return res.status(404).json({ error: 'NOT_FOUND', message: 'Communication not found' });
            }
            return res.status(200).json({ ok: true });
        } catch (error) {
            console.error('[communications] delete error:', error);
            return res.status(500).json({ error: 'Failed to delete communication' });
        }
    });

    return router;
}
