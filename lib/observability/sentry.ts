import * as Sentry from '@sentry/node';

export function isServerSentryEnabled(): boolean {
  if (!process.env.SENTRY_DSN) return false;
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.SENTRY_ENABLED === 'true' || process.env.SENTRY_ENABLED === '1';
}

export function setSentryUser(user: { id: string }): void {
  if (!isServerSentryEnabled()) return;
  Sentry.setUser({ id: user.id });
}

export function clearSentryUser(): void {
  if (!isServerSentryEnabled()) return;
  Sentry.setUser(null);
}

export function captureServerError(
  error: unknown,
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  }
): void {
  if (!isServerSentryEnabled()) return;

  Sentry.withScope((scope) => {
    if (context?.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value);
      }
    }
    if (context?.extra) {
      scope.setExtras(context.extra);
    }
    Sentry.captureException(error);
  });
}

export function captureServerWarning(
  message: string,
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  }
): void {
  if (!isServerSentryEnabled()) return;

  Sentry.withScope((scope) => {
    if (context?.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value);
      }
    }
    if (context?.extra) {
      scope.setExtras(context.extra);
    }
    Sentry.captureMessage(message, 'warning');
  });
}
