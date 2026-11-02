/**
 * Connection modes per hostname and the edge gate (read-only), under
 * `/api/admin/v1/instance/ingress/*`. Reads are open to admins; every change
 * is superadmin-only.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { listIngressCapabilities } from './capabilities.ts'
import { auditInstance, type IngressAdminDeps, notFound, routeServices } from './route-context.ts'
import {
  applyIngress,
  edgeGateReader,
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
    const gate = await edgeGateReader(ready.db, ready.service)()
    return c.json({ ok: true, modes: listIngressCapabilities(), gate })
  })
}

function registerHostnameWriteRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.patch('/instance/ingress/hostnames/:id', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const input = (await readBody(c)) as HostnameIngressInput
    const updated = await setHostnameIngress(
      ready.db,
      c.req.param('id'),
      input,
      edgeGateReader(ready.db, ready.service)
    )
    if (!updated.ok) {
      const { ok: _ok, status, ...body } = updated
      return c.json({ ok: false, ...body }, status)
    }
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
