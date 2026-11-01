/**
 * The control plane's own tunnel status, `/api/admin/v1/instance/ingress/tunnel`:
 * the connector on the control plane host and, with a connected Cloudflare
 * account, the tunnel at the edge. Works for a pasted run token too.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { getCommandQueue } from '../../../features/commands/queue.ts'
import { listIngressAccounts, openAccountToken } from './accounts.ts'
import {
  type InstanceTunnelView,
  readEdgeTunnel,
  readInstanceConnector,
  refreshInstanceConnector,
} from './cloudflare/instance-tunnel.ts'
import { type IngressAdminDeps, type RouteServices, routeServices } from './route-context.ts'
import { loadHostnamesWithState, networkFetch } from './service.ts'

async function edgeHalf(
  ready: RouteServices
): Promise<Pick<InstanceTunnelView, 'edge' | 'edgeNote'> & { edgeError: string | null }> {
  const [account] = (await listIngressAccounts(ready.db)).filter(
    (item) => item.provider === 'cloudflare'
  )
  if (!account)
    return {
      edge: null,
      edgeNote: 'Connect a Cloudflare account to see the tunnel at the edge.',
      edgeError: null,
    }
  try {
    const read = await readEdgeTunnel({
      account,
      token: await openAccountToken(ready.db, ready.service.dataEncryption, account),
      fetch: ready.service.fetch ?? networkFetch,
      hostnames: await loadHostnamesWithState(ready.db),
      now: new Date(),
    })
    return { edge: read.edge, edgeNote: read.note, edgeError: null }
  } catch (err) {
    // Provider errors are scrubbed of the token where they are made.
    return {
      edge: null,
      edgeNote: null,
      edgeError: err instanceof Error ? err.message : String(err),
    }
  }
}

async function describeTunnel(c: Context<AppEnv>, ready: RouteServices): Promise<Response> {
  const connector = await readInstanceConnector(ready.db, ready.service.registry)
  const edge = await edgeHalf(ready)
  return c.json({
    ok: true,
    connector: connector.connector,
    connectorNote: connector.note,
    ...edge,
  })
}

export function registerInstanceTunnelRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.get('/instance/ingress/tunnel', async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    return await describeTunnel(c, ready)
  })

  admin.post('/instance/ingress/tunnel/refresh', deps.rootOnly, async (c) => {
    const ready = routeServices(c, deps)
    if (ready instanceof Response) return ready
    const queue = getCommandQueue(c)
    if (queue) await refreshInstanceConnector(ready.db, ready.service.registry, queue)
    return await describeTunnel(c, ready)
  })
}
