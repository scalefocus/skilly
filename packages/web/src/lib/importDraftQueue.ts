// The repository import's AI draft queue (SKILLY_SPEC.md §64.5): drafts are requested from the
// browser, one per ticked skill, through the ordinary §43 endpoint, in step order, with at most 3
// in flight and at most 10 started per rolling minute (the §43 per-minute limit). A per-minute 429
// waits and tries again (a refused request never reached the provider, so it doesn't count); a
// daily-cap 429 stops the queue and every skill not yet drafted is reported as capped, until the
// page resumes it once the cap's time has passed; a 409 `ai_unavailable` stops it for good. A step's
// own Draft button (§64.4) puts its request at the front. A skill removed (or filled in by hand)
// before its draft is sent is dropped and never counted.
// Pure scheduling: the request, the clock and the timer are injected, so the unit test drives it.

export type DraftReply<T> =
  | { kind: "ok"; draft: T }
  | { kind: "minute" }
  | { kind: "day"; retryAt?: string | null }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

export type DraftEvent<T> =
  | { key: string; kind: "started" }
  | { key: string; kind: "ok"; draft: T }
  | { key: string; kind: "failed"; message: string }
  | { key: string; kind: "capped"; retryAt?: string | null }
  | { key: string; kind: "unavailable" };

export interface DraftQueueOptions<T> {
  send: (key: string) => Promise<DraftReply<T>>;
  onEvent: (e: DraftEvent<T>) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  maxInFlight?: number;
  perMinute?: number;
  /** How long to wait after a per-minute 429 before trying that draft again. */
  minuteRetryMs?: number;
}

export const DRAFT_MAX_IN_FLIGHT = 3;
export const DRAFT_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

export class DraftQueue<T> {
  private pending: string[] = [];
  private inFlight = new Set<string>();
  private started: number[] = [];
  private stopped: "day" | "unavailable" | null = null;
  private wakeAt: number | null = null;
  private readonly o: Required<Omit<DraftQueueOptions<T>, "send" | "onEvent">> & Pick<DraftQueueOptions<T>, "send" | "onEvent">;

  constructor(opts: DraftQueueOptions<T>) {
    this.o = {
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      maxInFlight: DRAFT_MAX_IN_FLIGHT,
      perMinute: DRAFT_PER_MINUTE,
      minuteRetryMs: 15_000,
      ...opts,
    };
  }

  /** Queue keys in order (already queued, in flight or capped keys are skipped). */
  enqueue(keys: readonly string[]): void {
    for (const k of keys) {
      if (this.stopped) {
        this.refuse(k);
        continue;
      }
      if (!this.pending.includes(k) && !this.inFlight.has(k)) this.pending.push(k);
    }
    this.pump();
  }

  /** Queue one key ahead of the rest: a step's own Draft button (§64.4). */
  enqueueFirst(key: string): void {
    if (this.stopped) {
      this.refuse(key);
      return;
    }
    if (this.inFlight.has(key)) return;
    const i = this.pending.indexOf(key);
    if (i >= 0) this.pending.splice(i, 1);
    this.pending.unshift(key);
    this.pump();
  }

  /** Accept drafts again after a daily-cap stop, once the cap's time has passed (§64.5). The
   *  server still decides; a 409 `ai_unavailable` stop is never lifted. */
  resume(): void {
    if (this.stopped === "day") this.stopped = null;
  }

  private refuse(key: string): void {
    this.o.onEvent(this.stopped === "unavailable" ? { key, kind: "unavailable" } : { key, kind: "capped" });
  }

  /** Drop a key that hasn't been sent yet. Returns false when it was already in flight (or unknown). */
  drop(key: string): boolean {
    const i = this.pending.indexOf(key);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  /** Move a key to the front of the queue (the step the proposer is looking at). */
  prioritize(key: string): void {
    const i = this.pending.indexOf(key);
    if (i > 0) {
      this.pending.splice(i, 1);
      this.pending.unshift(key);
    }
  }

  get pendingKeys(): readonly string[] {
    return this.pending;
  }

  get inFlightKeys(): ReadonlySet<string> {
    return this.inFlight;
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.o.now();
    this.started = this.started.filter((t) => now - t < MINUTE_MS);
    while (this.pending.length && this.inFlight.size < this.o.maxInFlight && this.started.length < this.o.perMinute) {
      const key = this.pending.shift()!;
      this.started.push(now);
      this.inFlight.add(key);
      this.o.onEvent({ key, kind: "started" });
      void this.run(key);
    }
    // Rate-bound with work left: wake when the oldest start leaves the minute window.
    if (this.pending.length && this.inFlight.size < this.o.maxInFlight && this.started.length >= this.o.perMinute) {
      this.wake(this.started[0]! + MINUTE_MS - now);
    }
  }

  private wake(ms: number): void {
    const at = this.o.now() + Math.max(0, ms);
    if (this.wakeAt !== null && this.wakeAt <= at) return;
    this.wakeAt = at;
    this.o.schedule(() => {
      this.wakeAt = null;
      this.pump();
    }, Math.max(0, ms));
  }

  private async run(key: string): Promise<void> {
    let reply: DraftReply<T>;
    try {
      reply = await this.o.send(key);
    } catch {
      reply = { kind: "failed", message: "Couldn't draft right now." };
    }
    this.inFlight.delete(key);
    if (reply.kind === "ok") this.o.onEvent({ key, kind: "ok", draft: reply.draft });
    else if (reply.kind === "failed") this.o.onEvent({ key, kind: "failed", message: reply.message });
    else if (reply.kind === "minute") {
      // Refused before the provider: not counted. Try it again first, a little later.
      this.started.pop();
      this.pending.unshift(key);
      this.wake(this.o.minuteRetryMs);
      return;
    } else if (reply.kind === "unavailable") {
      // AI was switched off: this one and everything still queued stop, for good.
      this.stopped = "unavailable";
      const left = [key, ...this.pending];
      this.pending = [];
      for (const k of left) this.o.onEvent({ key: k, kind: "unavailable" });
      return;
    } else {
      // The daily cap: this one and everything still queued is capped.
      this.stopped = "day";
      const left = [key, ...this.pending];
      this.pending = [];
      for (const k of left) this.o.onEvent({ key: k, kind: "capped", retryAt: reply.retryAt ?? null });
      return;
    }
    this.pump();
  }
}

/** Map a POST /api/propose/ai-draft response onto a queue reply (§43.5 status codes). */
export function draftReplyFromResponse<T>(status: number, body: Record<string, unknown> | null, toDraft: (b: Record<string, unknown>) => T): DraftReply<T> {
  if (status === 200 && body) return { kind: "ok", draft: toDraft(body) };
  if (status === 429 && body?.scope === "day") return { kind: "day", retryAt: typeof body.retryAt === "string" ? body.retryAt : null };
  if (status === 429) return { kind: "minute" };
  if (status === 409 && body?.error === "ai_unavailable") return { kind: "unavailable" };
  return { kind: "failed", message: typeof body?.message === "string" ? body.message : "Couldn't draft this one." };
}
