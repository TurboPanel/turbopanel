/**
 * The install-level Cloudflare account, under
 * `/api/admin/v1/instance/ingress/accounts`. Admins may read it (never the
 * token); a superadmin adds, rechecks and removes it.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { requireInstanceStepUp } from '../../../client/authn/step-up.ts'
import { listIngressAccounts } from './accounts.ts'
import {
  recheckIngressAccount,
  removeIngressAccount,
  saveIngressAccount,
  type AccountDeps,
} from './cloudflare/account.ts'
import { networkFetch } from './service.ts'
import {
  auditInstance,
  type IngressAdminDeps,
  routeServices,
  type RouteServices,
} from './route-context.ts'

function accountDeps(ready: RouteServices): AccountDeps {
  return {
    dataEncryption: ready.service.dataEncryption,
    fetch: ready.service.fetch ?? networkFetch,
  }
}

type AddBody = { provider?: unknown; label?: unknown; token?: unknown }

function parseAddBody(body: unknown): { label: string; token: string } | null {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as AddBody
  if (raw.provider !== undefined && raw.provider !== 'cloudflare') return null
  if (typeof raw.label !== 'string' || typeof raw.token !== 'string') return null
  return { label: raw.label, token: raw.token.trim() }
}

export function registerIngressAccountRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.get('/instance/ingress/accounts', async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    return c.json({ ok: true, accounts: await listIngressAccounts(ready.db) })
  })

  admin.post('/instance/ingress/accounts', deps.rootOnly, async (c) => {
    // The body is read once and never logged: it carries the token.
    const parsed = parseAddBody(await c.req.json().catch(() => null))
    if (!parsed) {
      return c.json({ ok: false, error: "expected { provider: 'cloudflare', label, token }" }, 400)
    }
    const stepUp = await requireInstanceStepUp(c, 'instance.ingress_account.added')
    if (stepUp) return stepUp
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const saved = await saveIngressAccount(
      ready.db,
      { ...parsed, createdByUserId: c.get('session')?.userId ?? null },
      accountDeps(ready)
    )
    if (!saved.ok) {
      return c.json({ ok: false, error: saved.error, preflight: saved.preflight }, saved.status)
    }
    await auditInstance(c, ready.db, 'instance.ingress_account.added', saved.id, {
      provider: 'cloudflare',
      label: parsed.label.trim(),
    })
    return c.json({ ok: true, id: saved.id, preflight: saved.preflight }, 201)
  })

  admin.post('/instance/ingress/accounts/:id/recheck', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const preflight = await recheckIngressAccount(ready.db, c.req.param('id'), accountDeps(ready))
    if (!preflight) return c.json({ ok: false, error: 'Account not found' }, 404)
    await auditInstance(c, ready.db, 'instance.ingress_account.rechecked', c.req.param('id'), {
      ok: preflight.ok,
    })
    return c.json(preflight)
  })

  admin.delete('/instance/ingress/accounts/:id', deps.rootOnly, async (c) => {
    const stepUp = await requireInstanceStepUp(c, 'instance.ingress_account.removed')
    if (stepUp) return stepUp
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const removed = await removeIngressAccount(ready.db, c.req.param('id'))
    if (!removed.ok) return c.json(removed, 409)
    await auditInstance(c, ready.db, 'instance.ingress_account.removed', c.req.param('id'))
    return c.json({ ok: true })
  })
}
