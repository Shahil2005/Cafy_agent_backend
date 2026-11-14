import type { Response } from 'express';
import type { AgentEvent } from './contract';

export interface AgentEventSink {
    send(event: AgentEvent): void;
    readonly closed: boolean;
}

/** Opens a Server-Sent Events stream; every event is one `data:` JSON line. */
export function openSse(res: Response): AgentEventSink {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Stops reverse proxies from buffering the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    return {
        send(event) {
            if (res.writableEnded || res.destroyed) return;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        get closed() {
            return res.writableEnded || res.destroyed;
        },
    };
}

/** Splits final text into small pieces so the client can render it progressively. */
export function textDeltas(text: string, size = 24): string[] {
    const words = text.split(/(\s+)/);
    const out: string[] = [];
    let current = '';
    for (const word of words) {
        current += word;
        if (current.length >= size) {
            out.push(current);
            current = '';
        }
    }
    if (current) out.push(current);
    return out;
}
