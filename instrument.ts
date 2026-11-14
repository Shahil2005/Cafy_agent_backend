import './env';
import * as Sentry from '@sentry/node';

const sentryEnabled =
    Boolean(process.env.SENTRY_DSN) &&
    (process.env.NODE_ENV === 'production' ||
        process.env.SENTRY_ENABLED === 'true' ||
        process.env.SENTRY_ENABLED === '1');

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.05 : 1.0,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    enabled: sentryEnabled,
    beforeSend(event) {
        // CV text and encrypted shortlist state are private request data.
        if (event.request?.url?.split('?')[0]?.endsWith('/api/jobs-portal/career-matches'))
            delete event.request.data;
        if (process.env.NODE_ENV !== 'production') {
            return null;
        }
        const status = event.contexts?.response?.status_code;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            return null;
        }
        return event;
    },
});
