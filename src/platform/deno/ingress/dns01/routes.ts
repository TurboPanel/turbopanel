/**
 * DNS-01 state per control plane hostname, under
 * `/api/admin/v1/instance/acme-dns/hostnames/:id`. Never returns a key, a
 * token or the challenge value.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../../../app/app.ts'
import { auditInstance, type IngressAdminDeps, routeServices } from '../route-context.ts'
import { loadDns01Row, type Dns01Row, startOrder } from './order.ts'
import { buildDns01Deps } from './runtime.ts'
import { inProgress, withStage } from './state.ts'

function describe(row: Dns01Row) {
  const { state } = row
  return {
    ok: true,
    stage: state.stage,
    attempts: state.attempts,
    nextAttemptAt: state.nextAttemptAt,
    stopUntil: state.stopUntil,
    lastError: state.lastError,
    renewAt: state.renewAt,
    notAfter: row.notAfter,
    expiryAlerted: state.expiryAlerted,
  }
}

function missing(c: Context<AppEnv>): Response {
  return c.json({ ok: false, error: 'No DNS-01 hostname with that id' }, 404)
}

/** Start an order now; `reset` (Retry) also clears the failure count. */
async function orderNow(
  c: Context<AppEnv>,
  deps: IngressAdminDeps,
  reset: boolean
): Promise<Response> {
  const ready = routeServices(c, deps)
  if (ready instanceof Response) return ready
  const row = await loadDns01Row(ready.db, c.req.param('id') ?? '')
  if (!row) return missing(c)
  if (inProgress(row.state.stage)) {
    return c.json({ ok: false, error: 'An order for this name is already open.' }, 409)
  }
  const dns01 = await buildDns01Deps(ready.db, {
    registry: ready.service.registry,
    secretsConfig: ready.service.secretsConfig,
    dataEncryption: ready.service.dataEncryption,
    env: ready.service.env,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })
  const target = reset
    ? { ...row, state: withStage(row.state, row.state.stage, { attempts: 0 }) }
    : row
  const result = await startOrder(dns01, target)
  if ('ok' in result) return c.json(result, 422)
  await auditInstance(c, ready.db, 'instance.dns01.ordered', row.id, {
    host: row.name,
    retry: reset,
  })
  const after = await loadDns01Row(ready.db, row.id)
  return c.json(after ? describe(after) : { ok: true })
}

export function registerDns01Routes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.get('/instance/acme-dns/hostnames/:id', async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const row = await loadDns01Row(ready.db, c.req.param('id'))
    return row ? c.json(describe(row)) : missing(c)
  })

  admin.post('/instance/acme-dns/hostnames/:id/order', deps.rootOnly, (c) =>
    orderNow(c, deps, false)
  )
  admin.post('/instance/acme-dns/hostnames/:id/retry', deps.rootOnly, (c) =>
    orderNow(c, deps, true)
  )
}
