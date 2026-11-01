/**
 * The once-a-minute DNS-01 pass over `dns-01` hostnames: move open orders
 * on, start orders that are due (first order, back-off elapsed, renewal
 * time), send the expiry countdown, and push the Platform CA fallback to the
 * daemon once a certificate has expired. Bounded per tick.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../../../db/connection.ts'
import { instanceHostname } from '../../../../db/schema.ts'
import { alertOnExpiry } from './alerts.ts'
import {
  advanceOrder,
  type Dns01Deps,
  type Dns01Row,
  loadDns01Row,
  saveDns01State,
  startOrder,
} from './order.ts'
import { type Dns01State, inProgress } from './state.ts'

/** Orders worked per tick; the rest wait a minute. */
export const DNS01_ROWS_PER_TICK = 5

function due(at: string | null, now: Date): boolean {
  const time = Date.parse(at ?? '')
  return !Number.isNaN(time) && time <= now.getTime()
}

/** Whether this row needs an order step now. */
export function needsWork(row: Pick<Dns01Row, 'state'>, now: Date): boolean {
  const { stage, nextAttemptAt, renewAt } = row.state
  if (inProgress(stage) || stage === 'idle') return true
  if (stage === 'backoff') return due(nextAttemptAt, now)
  if (stage === 'issued') return due(renewAt, now)
  return false
}

async function step(deps: Dns01Deps, row: Dns01Row): Promise<Dns01State> {
  if (inProgress(row.state.stage)) return await advanceOrder(deps, row)
  const started = await startOrder(deps, row)
  return 'ok' in started ? row.state : started
}

/** Countdown alerts and, once, the fallback push when the current pair has expired. */
async function watchExpiry(deps: Dns01Deps, id: string): Promise<void> {
  const row = await loadDns01Row(deps.db, id)
  if (!row?.notAfter) return
  const notAfter = new Date(row.notAfter)
  const now = deps.now()
  let state = await alertOnExpiry(row.state, row.name, notAfter, now, deps.notify)
  if (notAfter.getTime() <= now.getTime() && !state.expiryApplied) {
    await deps.applyToDaemon().catch(() => undefined)
    state = { ...state, expiryApplied: true }
  }
  if (state !== row.state) await saveDns01State(deps.db, row.id, state)
}

export async function runDns01Tick(deps: Dns01Deps): Promise<void> {
  const ids = await deps.db
    .select({ id: instanceHostname.id })
    .from(instanceHostname)
    .where(eq(instanceHostname.source, 'dns-01'))
  let worked = 0
  for (const { id } of ids) {
    const row = await loadDns01Row(deps.db, id)
    if (row && worked < DNS01_ROWS_PER_TICK && needsWork(row, deps.now())) {
      worked++
      await step(deps, row)
    }
    await watchExpiry(deps, id)
  }
}

/** Whether any hostname uses DNS-01, so the tick can skip building its dependencies. */
export async function anyDns01Hostname(db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: instanceHostname.id })
    .from(instanceHostname)
    .where(eq(instanceHostname.source, 'dns-01'))
    .limit(1)
  return rows.length > 0
}
