/** Small, defensive readers over panel JSON plus polling helpers for checks. */
import { isRecord } from '../safety.ts'
import type { ApiResponse, CheckContext, CheckOutcome, Json } from '../types.ts'

export type Rec = { [key: string]: Json }

export const pass = (evidence: string): CheckOutcome => ({ verdict: 'pass', evidence })
export const fail = (evidence: string): CheckOutcome => ({ verdict: 'fail', evidence })
export const skip = (evidence: string): CheckOutcome => ({ verdict: 'skip', evidence })

/** The first array found under one of `keys` (or the body itself when it is an array). */
export function listOf(body: Json, ...keys: string[]): Rec[] {
  if (Array.isArray(body)) return body.filter(isRecord)
  if (!isRecord(body)) return []
  for (const key of [...keys, 'data', 'items']) {
    const value = body[key]
    if (Array.isArray(value)) return value.filter(isRecord)
  }
  return []
}

/** The object under one of `keys`, or the body itself when none matches. */
export function objOf(body: Json, ...keys: string[]): Rec {
  if (!isRecord(body)) return {}
  for (const key of keys) {
    const value = body[key]
    if (isRecord(value)) return value
  }
  return body
}

export function str(rec: Rec | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = rec?.[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/** Throw with status and a short body excerpt unless the status is one of `ok`. */
export function expectStatus(res: ApiResponse, what: string, ...ok: number[]): ApiResponse {
  const allowed = ok.length > 0 ? ok : [200, 201, 202, 204]
  if (!allowed.includes(res.status)) {
    throw new Error(`${what}: HTTP ${res.status} ${excerpt(res.body)}`)
  }
  return res
}

export function excerpt(body: Json, max = 240): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * Poll `probe` every `everyMs` until it returns a value, at most `tries` times.
 * Sequential by construction (each probe waits for the previous one).
 */
export async function pollUntil<T>(
  ctx: Pick<CheckContext, 'sleep'>,
  probe: () => Promise<T | undefined>,
  tries: number,
  everyMs: number
): Promise<T | undefined> {
  const attempt = async (left: number): Promise<T | undefined> => {
    const value = await probe()
    if (value !== undefined || left <= 1) return value
    await ctx.sleep(everyMs)
    return attempt(left - 1)
  }
  return attempt(tries)
}

/** Run async steps strictly one after another, collecting their results. */
export async function sequential<T, R>(
  items: readonly T[],
  step: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = []
  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    out.push(await step(item))
  }, Promise.resolve())
  return out
}

/** Strict nested lookup: the record at `keys`, or `{}` when any step is missing. */
export function dig(body: Json, ...keys: string[]): Rec {
  let current: Json = body
  for (const key of keys) {
    if (!isRecord(current)) return {}
    current = current[key] ?? null
  }
  return isRecord(current) ? current : {}
}
