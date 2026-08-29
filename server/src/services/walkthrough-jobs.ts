import crypto from 'crypto';
import { BuildEvent } from './walkthrough';

/**
 * In-process registry for walkthrough builds.
 *
 * A build is minutes and dollars, so it cannot be a blocking request the way
 * Scout's scan is (already at the edge at 8 minutes). The client posts, gets a
 * job id back immediately, and follows progress over SSE.
 *
 * **Concurrency is capped at 1.** An Opus build at high effort should not run
 * three-up on this machine, and the cap is also a cost guardrail: a queue makes
 * a runaway click-fest visible instead of expensive.
 *
 * Jobs live only as long as the process. A server restart therefore orphans any
 * running build, which is why `initializeDatabase()` reaps `building` rows.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobEvent {
  /** Monotonic per job, so a reconnecting client can resume without replaying. */
  seq: number;
  event: BuildEvent | { type: 'status'; status: JobStatus; detail?: string };
}

export interface Job {
  id: string;
  arxivId: string;
  walkthroughId: number;
  status: JobStatus;
  events: JobEvent[];
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

interface InternalJob extends Job {
  subscribers: Set<(e: JobEvent) => void>;
  run: () => Promise<void>;
}

const MAX_CONCURRENT = 1;
/** Finished jobs are kept this long so a client that reconnects still sees the outcome. */
const JOB_TTL_MS = 30 * 60 * 1000;
/** Cap on buffered events per job — a chatty build should not grow without bound. */
const MAX_EVENTS = 4000;

const jobs = new Map<string, InternalJob>();
const queue: InternalJob[] = [];
let running = 0;

function prune(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.finishedAt) continue;
    if (now - new Date(job.finishedAt).getTime() > JOB_TTL_MS) jobs.delete(id);
  }
}

function emit(job: InternalJob, event: JobEvent['event']): void {
  const entry: JobEvent = { seq: job.events.length, event };
  if (job.events.length < MAX_EVENTS) {
    job.events.push(entry);
  } else if (job.events.length === MAX_EVENTS) {
    job.events.push({
      seq: MAX_EVENTS,
      event: { type: 'stage', stage: 'building', detail: '(further progress output elided)' },
    });
  }
  for (const subscriber of job.subscribers) {
    try {
      subscriber(entry);
    } catch {
      /* a broken SSE connection must not fail the build */
    }
  }
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    job.status = 'running';
    emit(job, { type: 'status', status: 'running' });

    job
      .run()
      .then(() => {
        job.status = 'done';
        emit(job, { type: 'status', status: 'done' });
      })
      .catch((err: unknown) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
        emit(job, { type: 'error', message: job.error });
        emit(job, { type: 'status', status: 'error', detail: job.error });
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        running--;
        prune();
        pump();
      });
  }
}

/**
 * Register a build. `work` receives the progress sink; anything it emits reaches
 * every SSE subscriber and is buffered for ones that connect late.
 */
export function startJob(
  arxivId: string,
  walkthroughId: number,
  work: (onEvent: (event: BuildEvent) => void) => Promise<void>
): Job {
  prune();

  const job: InternalJob = {
    id: crypto.randomUUID(),
    arxivId,
    walkthroughId,
    status: 'queued',
    events: [],
    createdAt: new Date().toISOString(),
    subscribers: new Set(),
    run: () => work(event => emit(job, event)),
  };

  jobs.set(job.id, job);
  queue.push(job);

  if (running >= MAX_CONCURRENT) {
    emit(job, {
      type: 'status',
      status: 'queued',
      detail: `waiting for ${running} build(s) ahead of this one`,
    });
  }
  // Start on the next tick so the caller can return 202 first.
  setImmediate(pump);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Is a build already queued or running for this walkthrough row? */
export function findActiveJobFor(walkthroughId: number): Job | undefined {
  for (const job of jobs.values()) {
    if (job.walkthroughId === walkthroughId && (job.status === 'queued' || job.status === 'running')) {
      return job;
    }
  }
  return undefined;
}

/**
 * Subscribe to a job's progress. Replays everything after `sinceSeq` first, so a
 * client that connects after the build started still sees the whole run.
 * Returns an unsubscribe function.
 */
export function subscribe(
  id: string,
  sinceSeq: number,
  onEvent: (e: JobEvent) => void
): (() => void) | null {
  const job = jobs.get(id);
  if (!job) return null;

  for (const entry of job.events) {
    if (entry.seq > sinceSeq) onEvent(entry);
  }
  if (job.status === 'done' || job.status === 'error') return () => {};

  job.subscribers.add(onEvent);
  return () => job.subscribers.delete(onEvent);
}
