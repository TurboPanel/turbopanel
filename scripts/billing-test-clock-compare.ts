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

/**
 * Equal as values, or, when both sides are timestamp strings, as the same
 * instant (a pg `2031-02-01 00:00:00+00` equals `2031-02-01T00:00:00.000Z`).
 */
export function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
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
