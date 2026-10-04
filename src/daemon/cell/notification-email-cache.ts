/**
 * Short-lived per-isolate cache for the cron tick's notification mail setup
 * (the mail queue plus from address, which cost settings reads and a secret
 * decrypt). Without it every 60 s tick paid for those reads three times even
 * when no alert, retry or digest was due.
 *
 * Keyed on the `env` object of the isolate, so a test or a redeploy that
 * builds a new env never sees another one's value. Only a resolved value is
 * cached; a failed or empty resolution is retried on the next call.
 */
export const NOTIFICATION_EMAIL_CACHE_TTL_MS = 5 * 60_000

type Entry<T> = { atMs: number; value: Promise<T | undefined> }

const entries = new WeakMap<object, Entry<unknown>>()

export function cachedForEnv<T>(
  env: object,
  resolve: () => Promise<T | undefined>,
  nowMs: number = Date.now(),
  ttlMs: number = NOTIFICATION_EMAIL_CACHE_TTL_MS
): Promise<T | undefined> {
  const hit = entries.get(env) as Entry<T> | undefined
  if (hit && nowMs - hit.atMs < ttlMs) return hit.value
  const value = resolve().then((resolved) => {
    // Do not pin a failure: let the next call try again.
    if (resolved === undefined && entries.get(env)?.value === value) {
      entries.delete(env)
    }
    return resolved
  })
  entries.set(env, { atMs: nowMs, value })
  return value
}
