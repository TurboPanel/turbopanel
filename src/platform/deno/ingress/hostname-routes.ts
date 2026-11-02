/**
 * Connection modes per hostname and the edge go-live gate, under
 * `/api/admin/v1/instance/ingress/*`. Reads are open to admins; every change
 * is superadmin-only.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { requireInstanceStepUp } from '../../../client/authn/step-up.ts'
import { listIngressCapabilities } from './capabilities.ts'
import { readEdgeGate, writeEdgeGate } from './gate.ts'
import { auditInstance, type IngressAdminDeps, notFound, routeServices } from './route-context.ts'
import {
  applyIngress,
  ingressStatus,
  preflightIngress,
  removeIngress,
  setHostnameIngress,
  type HostnameIngressInput,
} from './service.ts'

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

function registerGateRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.get('/instance/ingress/capabilities', async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const gate = await readEdgeGate(ready.db, ready.service.env)
    return c.json({ ok: true, modes: listIngressCapabilities(), gate })
  })

  admin.put('/instance/ingress/gate', deps.rootOnly, async (c) => {
    const body = await readBody(c)
    if (typeof body.confirmed !== 'boolean') {
      return c.json({ ok: false, error: 'confirmed must be true or false' }, 400)
    }
    const stepUp = await requireInstanceStepUp(c, 'instance.edge_gate.set')
    if (stepUp) return stepUp
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    await writeEdgeGate(ready.db, body.confirmed, c.get('session')?.email ?? null)
    await auditInstance(c, ready.db, 'instance.edge_gate.set', null, { confirmed: body.confirmed })
    return c.json({ ok: true, gate: await readEdgeGate(ready.db, ready.service.env) })
  })
}

function registerHostnameWriteRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.patch('/instance/ingress/hostnames/:id', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const input = (await readBody(c)) as HostnameIngressInput
    const updated = await setHostnameIngress(ready.db, c.req.param('id'), input)
    if (!updated.ok) return c.json({ ok: false, error: updated.error }, updated.status)
    await auditInstance(c, ready.db, 'instance.hostname_ingress.changed', updated.hostname.id, {
      host: updated.hostname.host,
      mode: updated.hostname.mode,
      publicPort: updated.hostname.publicPort,
    })
    return c.json({ ok: true, hostname: updated.hostname })
  })

  admin.post('/instance/ingress/hostnames/:id/apply', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const body = await readBody(c)
    const result = await applyIngress(ready.db, c.req.param('id'), ready.service, {
      replaceExisting: body.replaceExisting === true,
    })
    if (!result) return notFound(c)
    if (!result.ok) return c.json(result, 422)
    await auditInstance(c, ready.db, 'instance.hostname_ingress.applied', c.req.param('id'))
    return c.json({ ok: true })
  })

  admin.post('/instance/ingress/hostnames/:id/remove', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const removed = await removeIngress(ready.db, c.req.param('id'), ready.service)
    if (!removed) return notFound(c)
    await auditInstance(c, ready.db, 'instance.hostname_ingress.removed', c.req.param('id'))
    return c.json({ ok: true })
  })
}

function registerHostnameCheckRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.post('/instance/ingress/hostnames/:id/preflight', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const result = await preflightIngress(ready.db, c.req.param('id'), ready.service)
    return result ? c.json(result) : notFound(c)
  })

  admin.get('/instance/ingress/hostnames/:id/status', async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const status = await ingressStatus(ready.db, c.req.param('id'), ready.service)
    return status ? c.json(status) : notFound(c)
  })
}

export function registerHostnameIngressRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  registerGateRoutes(admin, deps)
  registerHostnameWriteRoutes(admin, deps)
  registerHostnameCheckRoutes(admin, deps)
}
