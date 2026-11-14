import { createResumeSupabaseClient } from '../lib/mentorStorage';
import { captureServerError } from '../lib/observability/sentry';
import { expireStaleReservations } from './bookingRepository';
import { isCounsellingEnabled } from './config';

const INTERVAL_MS = 5 * 60 * 1000;

export function startCounsellingMaintenanceCron(): void {
    if (!isCounsellingEnabled()) {
        return;
    }

    const db = createResumeSupabaseClient();

    const run = () => {
        expireStaleReservations(db).catch((err) => {
            console.error('[counselling cron] expire stale reservations failed', err);
            captureServerError(err, { tags: { feature: 'counselling', cron: 'expire-stale' } });
        });
    };

    run();
    setInterval(run, INTERVAL_MS);
}
