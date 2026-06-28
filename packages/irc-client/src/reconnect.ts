import {
  asyncScheduler,
  retry,
  timer,
  type MonoTypeOperatorFunction,
  type SchedulerLike,
} from "rxjs";

/** Reconnection / backoff policy (fully resolved — see `options.ts` for defaults). */
export interface ReconnectPolicy {
  /** When false, a dropped connection is not retried. */
  readonly enabled: boolean;
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Upper bound on any single backoff delay, in milliseconds. */
  readonly maxDelayMs: number;
  /** Multiplier applied to the delay after each successive failure. */
  readonly factor: number;
  /** When true, apply equal jitter (halve the delay, randomize the other half). */
  readonly jitter: boolean;
  /** Maximum retry attempts; `Infinity` for unlimited. */
  readonly maxRetries: number;
}

/** Injectable seams for {@link retryWithBackoff} (deterministic in tests). */
export interface BackoffDeps {
  /** Scheduler for the delay timer (default `asyncScheduler`). */
  readonly scheduler?: SchedulerLike;
  /** RNG in `[0, 1)` for jitter (default `Math.random`). */
  readonly random?: () => number;
  /** Notified just before each backoff wait, with the 1-based attempt + chosen delay. */
  readonly onRetry?: (attempt: number, delayMs: number) => void;
}

/**
 * Compute the backoff delay for a given retry attempt.
 *
 * The base grows geometrically — `initialDelayMs * factor^(attempt-1)` — clamped
 * to `maxDelayMs`. With jitter, "equal jitter" is applied: half the base is
 * fixed and the other half is randomized, which spreads reconnect storms without
 * letting the delay collapse toward zero.
 *
 * @param attempt - 1-based retry number (the first retry is `1`).
 */
export function backoffDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** exponent);
  if (!policy.jitter) return base;
  const half = base / 2;
  return half + random() * half;
}

/**
 * Retry a source observable with exponential backoff on error.
 *
 * Errors trigger a resubscribe after {@link backoffDelay}, up to
 * `policy.maxRetries`. A disabled policy passes errors straight through (no
 * retry). Local completion (e.g. a deliberate quit, which *completes* rather
 * than errors) is never retried.
 *
 * The `onRetry` hook fires before each wait so the caller can surface a
 * "reconnecting" lifecycle event with the same attempt/delay values.
 */
export function retryWithBackoff<T>(
  policy: ReconnectPolicy,
  deps: BackoffDeps = {},
): MonoTypeOperatorFunction<T> {
  const scheduler = deps.scheduler ?? asyncScheduler;
  const random = deps.random ?? Math.random;
  if (!policy.enabled) {
    return retry<T>({ count: 0 });
  }
  return retry<T>({
    count: policy.maxRetries === Infinity ? undefined : policy.maxRetries,
    // Reset the backoff (and the retry budget) once the source emits — the
    // client emits on a successful registration — so `maxRetries` counts
    // failures per outage and backoff restarts from `initialDelayMs` after a
    // stable connection, rather than climbing for the client's whole lifetime.
    resetOnSuccess: true,
    delay: (_error: unknown, retryCount: number) => {
      const delayMs = backoffDelay(retryCount, policy, random);
      deps.onRetry?.(retryCount, delayMs);
      return timer(delayMs, scheduler);
    },
  });
}
