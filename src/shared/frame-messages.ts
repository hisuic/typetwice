/**
 * window.postMessage signals from the gate iframe (an extension page) to the
 * content script in the page that embeds it. None of them can unlock a page
 * by itself: "unlocked" only makes the content script ask the worker again.
 */
export type FrameSignal = 'ready' | 'unlocked' | 'refresh' | 'go-back';

export interface FrameMessage {
  typetwice: FrameSignal;
}

const SIGNALS: ReadonlySet<string> = new Set<FrameSignal>(['ready', 'unlocked', 'refresh', 'go-back']);

export function isFrameMessage(data: unknown): data is FrameMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { typetwice?: unknown }).typetwice === 'string' &&
    SIGNALS.has((data as { typetwice: string }).typetwice)
  );
}

export const GATE_PAGE = 'gate.html';
