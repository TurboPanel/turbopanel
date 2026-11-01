/**
 * `cloudflare-tunnel`: the control plane creates (or adopts) one remotely
 * managed tunnel per account, points every tunnel hostname at its own
 * loopback listener, publishes a proxied CNAME per name and hands the run
 * token to the co-located daemon only, which runs the connector.
 */
import { CloudflareClient } from '../../../../features/tunnels/cloudflare-client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import { zoneForName } from '../accounts.ts'
import { capabilitiesFor } from '../capabilities.ts'
import {
  appliedTunnelRows,
  buildPanelIngress,
  dnsName,
  readTunnelState,
  tunnelName,
  tunnelIdFromTarget,
  tunnelPhase,
  tunnelTarget,
  type TunnelState,
} from '../cloudflare/tunnel-config.ts'
import { check, planHostname } from '../planner.ts'
import type {
  ApplyResult,
  IngressCause,
  IngressContext,
  IngressDeps,
  IngressProvider,
  IngressStatus,
  PreflightCheck,
  PreflightResult,
} from '../provider.ts'

const ALLOWED_PORTS = [443, 8443] as const
const SELF_CHECK_TIMEOUT_MS = 10_000
const IDENTITY_PATH = '/api/daemon/v1/instance/identity'

type Ready = { deps: IngressDeps; name: string; zoneId: string; accountId: string; token: string }

function refused(cause: IngressCause, detail: string): ApplyResult {
  return { ok: false, cause, detail }
}

function causeFor(err: TunnelProviderError): IngressCause {
  if (err.code === 'unauthorized') return 'token-invalid'
  if (err.code === 'forbidden') return 'scope-missing'
  if (err.code === 'rate_limited') return 'provider-rate-limited'
  return 'provider-error'
}

function portCheck(port: number): PreflightCheck {
  const ok = (ALLOWED_PORTS as readonly number[]).includes(port)
  return check(
    'public-port',
    ok,
    ok ? `Visitors use port ${port}.` : 'This mode needs port 443 or 8443.'
  )
}

function accountChecks(ctx: IngressContext, name: string | null): PreflightCheck[] {
  const account = ctx.deps?.account ?? null
  if (account?.provider !== 'cloudflare') {
    return [check('account', false, 'Choose a connected Cloudflare account for this hostname.')]
  }
  const scopes = account.scopes
  const scoped = scopes?.tunnels === true && scopes.dns === true
  const zone = name && scopes ? zoneForName(scopes.zones, name) : null
  return [
    check(
      'account',
      scoped,
      scoped
        ? 'The Cloudflare token can manage tunnels and DNS.'
        : 'The Cloudflare token is missing a scope. Recheck it in Cloudflare Connection.'
    ),
    check(
      'zone',
      zone !== null,
      zone
        ? `The name is in the ${zone.name} zone.`
        : 'The name is not in a zone the token can edit.'
    ),
  ]
}

async function daemonCheck(deps: IngressDeps | undefined): Promise<PreflightCheck> {
  if (deps && (await deps.colocatedDaemonConnected())) {
    return check(
      'daemon',
      true,
      'The daemon on the control plane host is connected and runs the connector.'
    )
  }
  return check(
    'daemon',
    false,
    'The daemon on the control plane host is not connected, so it cannot run the connector.'
  )
}

async function preflight(ctx: IngressContext): Promise<PreflightResult> {
  const name = dnsName(ctx.hostname.host)
  const base = planHostname(ctx.hostname, false).checks
  const checks = [
    ...base,
    portCheck(ctx.hostname.publicPort),
    ...accountChecks(ctx, name),
    await daemonCheck(ctx.deps),
  ]
  return { ok: checks.every((item) => item.ok), checks }
}

async function prepare(ctx: IngressContext): Promise<Ready | ApplyResult> {
  const deps = ctx.deps
  const account = deps?.account
  const name = dnsName(ctx.hostname.host)
  if (!deps || !account?.accountId || !name) {
    return refused('account-missing', 'Choose a connected Cloudflare account for this hostname.')
  }
  const zone = zoneForName(account.scopes?.zones ?? [], name)
  if (!zone) return refused('zone-not-found', 'The name is not in a zone the token can edit.')
  const token = await deps.openToken(account)
  return { deps, name, zoneId: zone.id, accountId: account.accountId, token }
}

/** The account's tunnel: the one another hostname already uses, else one with our name, else a new one. */
type FoundTunnel = { id: string; name: string; adopted: boolean }

/** A tunnel the name's CNAME already points at, when it belongs to this account. */
async function tunnelBehindName(api: CloudflareClient, ready: Ready): Promise<FoundTunnel | null> {
  const records = await api.listDnsRecords(ready.zoneId, ready.name)
  const id = records.map((record) => tunnelIdFromTarget(record.content)).find(Boolean)
  if (!id) return null
  try {
    const tunnel = await api.getTunnel(ready.accountId, id)
    return { id: tunnel.id, name: tunnel.name, adopted: true }
  } catch {
    return null
  }
}

/**
 * The account's tunnel, in this order: the one this or another hostname
 * already uses, the one the name's CNAME points at (made in the Cloudflare
 * dashboard: adopted, never deleted), one with our name, else a new one.
 */
async function ensureTunnel(
  api: CloudflareClient,
  ready: Ready,
  ctx: IngressContext
): Promise<FoundTunnel> {
  const shared = appliedTunnelRows(
    ready.deps.hostnames,
    ctx.hostname.ingressId ?? '',
    ctx.hostname.id
  )
  const known = readTunnelState(ownState(ctx)) ?? shared[0]?.state
  if (known) return { id: known.tunnelId, name: known.tunnelName, adopted: known.adopted }
  const behind = await tunnelBehindName(api, ready)
  if (behind) return behind
  const name = tunnelName(ready.deps.instanceId)
  const [existing] = await api.listTunnels(ready.accountId, name)
  if (existing) return { id: existing.id, name, adopted: false }
  return { id: (await api.createTunnel(ready.accountId, name)).id, name, adopted: false }
}

function ownState(ctx: IngressContext): unknown {
  return ctx.deps?.hostnames.find((row) => row.id === ctx.hostname.id)?.providerState ?? null
}

function namesOnTunnel(ctx: IngressContext, include: string | null): string[] {
  const others = appliedTunnelRows(
    ctx.deps?.hostnames ?? [],
    ctx.hostname.ingressId ?? '',
    ctx.hostname.id
  )
  const names = others.flatMap(({ row }) => dnsName(row.host) ?? [])
  return include ? [...names, include] : names
}

/** The CNAME for the name: kept when it already points at the tunnel, replaced only when asked. */
async function ensureDns(
  api: CloudflareClient,
  ready: Ready,
  tunnelId: string,
  replaceExisting: boolean
): Promise<{ id: string; created: boolean } | ApplyResult> {
  const target = tunnelTarget(tunnelId)
  const records = await api.listDnsRecords(ready.zoneId, ready.name)
  const ours = records.find((record) => record.type === 'CNAME' && record.content === target)
  if (ours) return { id: ours.id, created: false }
  const other = records[0]
  if (other && !replaceExisting) {
    return refused(
      'dns-conflict',
      `A DNS record for ${ready.name} already exists. Remove it, or let the control plane replace it.`
    )
  }
  const record = { name: ready.name, content: target }
  const written = other
    ? await api.putDnsRecord(ready.zoneId, other.id, record)
    : await api.createDnsRecord(ready.zoneId, record)
  return { id: written.id, created: true }
}

async function pushRunToken(deps: IngressDeps, token: string): Promise<ApplyResult | null> {
  const pushed = await deps.pushRunToken(token)
  return pushed.ok
    ? null
    : refused('daemon-offline', `The connector could not be started: ${pushed.error}`)
}

async function applyWith(
  api: CloudflareClient,
  ready: Ready,
  ctx: IngressContext
): Promise<ApplyResult> {
  const tunnel = await ensureTunnel(api, ready, ctx)
  const existing = await api.getConfiguration(ready.accountId, tunnel.id)
  const ingress = buildPanelIngress(namesOnTunnel(ctx, ready.name), existing)
  await api.putConfiguration(ready.accountId, tunnel.id, ingress)
  const dns = await ensureDns(api, ready, tunnel.id, ctx.replaceExisting === true)
  if ('ok' in dns) return dns
  const runToken = await api.getTunnelToken(ready.accountId, tunnel.id)
  const pushFailed = await pushRunToken(ready.deps, runToken)
  if (pushFailed) return pushFailed
  const state: TunnelState = {
    tunnelId: tunnel.id,
    tunnelName: tunnel.name,
    accountId: ready.accountId,
    zoneId: ready.zoneId,
    dnsRecordId: dns.id,
    createdRecord: dns.created,
    adopted: tunnel.adopted,
    tokenPushedAt: ready.deps.now().toISOString(),
  }
  return { ok: true, state }
}

async function withProvider<T>(
  run: () => Promise<T>,
  onError: (cause: IngressCause, detail: string) => T
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof TunnelProviderError) return onError(causeFor(err), err.message)
    throw err
  }
}

async function apply(ctx: IngressContext): Promise<ApplyResult> {
  const ready = await prepare(ctx)
  if ('ok' in ready) return ready
  const api = new CloudflareClient({ token: ready.token, fetch: ready.deps.fetch })
  return await withProvider(() => applyWith(api, ready, ctx), refused)
}

/** Fetch the identity document through the edge and check it is this control plane's own. */
async function selfCheck(deps: IngressDeps, name: string, port: number): Promise<boolean> {
  const portPart = port === 443 ? '' : `:${port}`
  try {
    const response = await deps.fetch(`https://${name}${portPart}${IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(SELF_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = await response.text()
    return await deps.isOwnIdentity(body, response.headers.get('x-turbopanel-signature'))
  } catch {
    return false
  }
}

async function statusWith(
  ctx: IngressContext,
  deps: IngressDeps,
  state: TunnelState
): Promise<IngressStatus> {
  const account = deps.account
  if (!account)
    return {
      phase: 'failed',
      cause: 'account-missing',
      detail: 'The Cloudflare account was removed.',
    }
  const api = new CloudflareClient({ token: await deps.openToken(account), fetch: deps.fetch })
  const detail = await api.getTunnel(state.accountId, state.tunnelId)
  const health = tunnelPhase(detail, state.tokenPushedAt, deps.now())
  const facts = { tunnel: state.tunnelName, connections: health.connections }
  if (health.phase !== 'healthy' && health.phase !== 'degraded')
    return { phase: health.phase, facts }
  const reached = await selfCheck(deps, dnsName(ctx.hostname.host) ?? '', ctx.hostname.publicPort)
  if (reached) return { phase: health.phase, facts: { ...facts, selfCheck: true } }
  return {
    phase: 'degraded',
    cause: 'edge-unreachable',
    detail: 'The control plane could not reach itself through Cloudflare.',
    facts: { ...facts, selfCheck: false },
  }
}

async function status(ctx: IngressContext): Promise<IngressStatus> {
  const deps = ctx.deps
  const state = readTunnelState(ownState(ctx))
  if (!deps || !state) return { phase: 'not-applied' }
  return await withProvider(
    () => statusWith(ctx, deps, state),
    (cause, detail): IngressStatus => ({ phase: 'failed', cause, detail })
  )
}

async function removeWith(
  ctx: IngressContext,
  deps: IngressDeps,
  state: TunnelState
): Promise<void> {
  const account = deps.account
  if (!account) return
  const api = new CloudflareClient({ token: await deps.openToken(account), fetch: deps.fetch })
  if (state.createdRecord && state.dnsRecordId) {
    await ignoreGone(() => api.deleteDnsRecord(state.zoneId, state.dnsRecordId))
  }
  const remaining = namesOnTunnel(ctx, null)
  if (remaining.length > 0 || state.adopted) {
    // An adopted tunnel keeps running with its other rules; only our name goes.
    const existing = await api.getConfiguration(state.accountId, state.tunnelId)
    const dropped = [dnsName(ctx.hostname.host) ?? '']
    const ingress = buildPanelIngress(remaining, existing, dropped)
    await api.putConfiguration(state.accountId, state.tunnelId, ingress)
    return
  }
  // Last name on the tunnel: stop the connector first, then the tunnel can go.
  await pushRunToken(deps, '')
  await ignoreGone(() => api.deleteTunnel(state.accountId, state.tunnelId))
}

async function ignoreGone(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code === 'not_found') return
    throw err
  }
}

async function remove(ctx: IngressContext): Promise<void> {
  const deps = ctx.deps
  const state = readTunnelState(ownState(ctx))
  if (!deps || !state) return
  await removeWith(ctx, deps, state)
}

export const cloudflareTunnelProvider: IngressProvider = {
  mode: 'cloudflare-tunnel',
  capabilities: capabilitiesFor('cloudflare-tunnel'),
  preflight,
  apply,
  status,
  remove,
}
