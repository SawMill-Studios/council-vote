/** Offline write queue. Retries are idempotent because every item carries a client id. */

export interface QueueItem {
  id: string;
  kind: "sticky" | "dot" | "undo" | "patch";
  url: string;
  method: "POST" | "PATCH" | "DELETE";
  body: unknown;
  attempts: number;
  nextAt: number;
}

export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 1000;
  return Math.min(30_000, 1000 * 2 ** attempts);
}

export function enqueueItem(queue: readonly QueueItem[], item: QueueItem): QueueItem[] {
  if (queue.some((existing) => existing.id === item.id && existing.kind === item.kind)) return [...queue];
  return [...queue, item];
}

export function markRetry(item: QueueItem, now: number): QueueItem {
  const attempts = item.attempts + 1;
  return { ...item, attempts, nextAt: now + retryDelayMs(attempts) };
}

export function dueItems(queue: readonly QueueItem[], now: number): QueueItem[] {
  return queue.filter((item) => item.nextAt <= now);
}

export type WriteOutcome = "ok" | "retry" | "drop";

/** 429 and 5xx are retried with the same body. Anything else the server rejected is dropped. */
export function writeOutcome(status: number): WriteOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  return "drop";
}
