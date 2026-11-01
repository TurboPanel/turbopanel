/**
 * The self-hosted ingress tick, once a minute from `server.ts` with a fresh
 * database client: DNS-01 orders and renewals, tunnel health of applied edge
 * names, and the daily recheck of provider tokens. Each part fails alone.
 */
import type { Db } from '../../../db/connection.ts'
import { logWarn } from '../../../lib/logger.ts'
import { listIngressAccounts } from './accounts.ts'
import { accountsDueForRecheck, recheckIngressAccount } from './cloudflare/account.ts'
import { buildDns01Deps, type Dns01RuntimeDeps } from './dns01/runtime.ts'
import { anyDns01Hostname, runDns01Tick } from './dns01/tick.ts'
import { networkFetch, refreshEdgeStatuses, type IngressServiceDeps } from './service.ts'

/** Edge status is read every few minutes, not every tick, to stay well inside provider limits. */
export const EDGE_STATUS_EVERY_MS = 5 * 60_000

export type IngressTickDeps = IngressServiceDeps & Pick<Dns01RuntimeDeps, 'email'>

async function guarded(part: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    logWarn('ingress', `${part} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function recheckAccounts(db: Db, deps: IngressTickDeps): Promise<void> {
  const now = deps.now?.() ?? new Date()
  for (const account of accountsDueForRecheck(await listIngressAccounts(db), now)) {
    await recheckIngressAccount(db, account.id, {
      dataEncryption: deps.dataEncryption,
      fetch: deps.fetch ?? networkFetch,
      now: () => now,
    })
  }
}

export function createIngressTick(deps: IngressTickDeps): (db: Db) => Promise<void> {
  let lastStatusAt = 0
  return async (db) => {
    await guarded('DNS-01 tick', async () => {
      if (!(await anyDns01Hostname(db))) return
      await runDns01Tick(await buildDns01Deps(db, deps))
    })
    const now = (deps.now?.() ?? new Date()).getTime()
    if (now - lastStatusAt < EDGE_STATUS_EVERY_MS) return
    lastStatusAt = now
    await guarded('edge status refresh', () => refreshEdgeStatuses(db, deps))
    await guarded('provider token recheck', () => recheckAccounts(db, deps))
  }
}

/** Every minute: the same cadence as the other Deno certificate sweeps. */
export const INGRESS_TICK_MS = 60_000

/**
 * Start the tick. A fresh database client per run, always closed, and no
 * overlap: a slow run makes the next one skip, never pile up.
 */
export function startIngressTimer(
  deps: IngressTickDeps,
  db: { open: () => Db; close: (db: Db) => Promise<void> }
): ReturnType<typeof setInterval> {
  const tick = createIngressTick(deps)
  let running = false
  return setInterval(() => {
    if (running) return
    running = true
    void (async () => {
      const tickDb = db.open()
      try {
        await tick(tickDb)
      } finally {
        await db.close(tickDb).catch(() => {})
        running = false
      }
    })()
  }, INGRESS_TICK_MS)
}
