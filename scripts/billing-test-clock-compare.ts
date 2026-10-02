/**
 * Pure helpers for the billing test-clock harness: no Stripe, no database,
 * so they are unit-tested in CI (`billing-test-clock-compare.test.ts`).
 */

/** The refusal a mutation answers with while another holds the org's quantity lease. */
export const LEASE_BUSY_ERROR = 'billing_mutation_in_progress'

const PG_OR_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/

/** A timestamp string that carries an explicit offset (pg `timestamptz` text or ISO 8601). */
function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !PG_OR_ISO_TIMESTAMP.test(value)) return null
  // pg prints "2031-02-01 00:00:00+00": Date.parse wants a "T" and a full offset.
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameArray(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && actual.every((v, i) => sameValue(v, expected[i]))
}

function sameObject(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const keys = Object.keys(actual)
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => key in expected && sameValue(actual[key], expected[key]))
  )
}

/**
 * Equal as values: arrays and plain objects element by element, and, when
 * both sides are timestamp strings, as the same instant (a pg
 * `2031-02-01 00:00:00+00` equals `2031-02-01T00:00:00.000Z`).
 */
export function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (Array.isArray(actual) && Array.isArray(expected)) return sameArray(actual, expected)
  if (isPlainObject(actual) && isPlainObject(expected)) return sameObject(actual, expected)
  const a = timestampMs(actual)
  const b = timestampMs(expected)
  return a !== null && b !== null && a === b
}

type MaybeRefusal = Readonly<{ ok: boolean; status?: number; body?: unknown }>

function isLeaseBusy(outcome: MaybeRefusal): boolean {
  if (outcome.ok || outcome.status !== 409) return false
  const body = outcome.body as { error?: unknown } | undefined
  return body?.error === LEASE_BUSY_ERROR
}

export type LeaseRetryOpts = Readonly<{
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}>

/**
 * Run a mutation; while it answers `409 billing_mutation_in_progress` (the
 * previous call's lease not yet released), wait and run it again. Any other
 * outcome, refusal or not, is returned as is.
 */
export async function retryWhileLeaseBusy<T extends MaybeRefusal>(
  run: () => Promise<T>,
  opts: LeaseRetryOpts = {}
): Promise<T> {
  const attempts = opts.attempts ?? 8
  const delayMs = opts.delayMs ?? 1_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let outcome = await run()
  for (let attempt = 1; attempt < attempts && isLeaseBusy(outcome); attempt += 1) {
    await sleep(delayMs)
    outcome = await run()
  }
  return outcome
}
