export type ChatExecutionErrorKind = 'timeout' | 'cancelled';

/** No request data, provider payload, URLs or credentials are included in execution errors. */
export class ChatExecutionError extends Error {
    constructor(readonly kind: ChatExecutionErrorKind) {
        super(
            kind === 'timeout'
                ? 'Chat request timed out.'
                : 'Chat request was cancelled.',
        );
        this.name = 'ChatExecutionError';
    }
}

export interface ChatExecution {
    signal: AbortSignal;
    remainingMs(): number;
    run<T>(task: () => Promise<T>): Promise<T>;
    /** Cancel outstanding work and remove the deadline and parent-signal listener. Idempotent. */
    cleanup(): void;
}

/** One shared request budget; starting another task never resets its deadline. */
export function createChatExecution(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
): ChatExecution {
    const requested = options.timeoutMs ?? 60_000;
    const timeoutMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(120_000, Math.floor(requested)))
        : 60_000;
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    let stoppedKind: ChatExecutionErrorKind | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false;
    const removeSources = () => {
        if (deadline !== undefined) clearTimeout(deadline);
        options.signal?.removeEventListener('abort', onParentAbort);
    };
    const stop = (kind: ChatExecutionErrorKind) => {
        if (controller.signal.aborted) return;
        stoppedKind = kind;
        removeSources();
        controller.abort();
    };
    const onParentAbort = () => stop('cancelled');
    if (options.signal?.aborted) stop('cancelled');
    else if (!timeoutMs) stop('timeout');
    else {
        options.signal?.addEventListener('abort', onParentAbort, {
            once: true,
        });
        deadline = setTimeout(() => stop('timeout'), timeoutMs);
    }
    const remainingMs = () =>
        controller.signal.aborted ? 0 : Math.max(0, deadlineAt - Date.now());
    const executionError = () =>
        new ChatExecutionError(stoppedKind || 'timeout');
    return {
        signal: controller.signal,
        remainingMs,
        run<T>(task: () => Promise<T>): Promise<T> {
            if (!remainingMs() && !controller.signal.aborted) stop('timeout');
            if (controller.signal.aborted)
                return Promise.reject(executionError());
            return new Promise<T>((resolve, reject) => {
                const onAbort = () => {
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(executionError());
                };
                controller.signal.addEventListener('abort', onAbort, {
                    once: true,
                });
                let pending: Promise<T>;
                try {
                    // Deferring to another microtask could execute an already
                    // cancelled task; start only after the synchronous gate.
                    pending = task();
                } catch (error) {
                    if (!remainingMs() && !controller.signal.aborted)
                        stop('timeout');
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(
                        controller.signal.aborted ? executionError() : error,
                    );
                    return;
                }
                Promise.resolve(pending).then(
                    (value) => {
                        if (!remainingMs() && !controller.signal.aborted)
                            stop('timeout');
                        controller.signal.removeEventListener('abort', onAbort);
                        if (controller.signal.aborted) reject(executionError());
                        else resolve(value);
                    },
                    (error) => {
                        if (!remainingMs() && !controller.signal.aborted)
                            stop('timeout');
                        controller.signal.removeEventListener('abort', onAbort);
                        reject(
                            controller.signal.aborted
                                ? executionError()
                                : error,
                        );
                    },
                );
            });
        },
        cleanup() {
            if (cleaned) return;
            cleaned = true;
            stop('cancelled');
            removeSources();
        },
    };
}
