/**
 * Glue between the admin routes, the tick and the providers: build the
 * context for one hostname, run a provider step and keep what it returned in
 * `origin.ingress_state` (`{ provider, status, lastApply }`). No token is ever
 * written there.
 */
import { eq } from 'drizzle-orm'
import { resolveColocatedServerId } from '../../../client/authn/install-state.ts'
import type { DaemonCellRegistry } from '../../../contracts/cell.ts'
import type { Db } from '../../../db/connection.ts'
import { instanceHostname, setting } from '../../../db/schema.ts'
import { dispatchInstanceTunnelToken } from '../../../developer/tunnel-token.ts'
import { isIngressMode, isPublicPort } from '../../../features/install/ingress-modes.ts'
import {
  listInstanceHostnames,
  type InstanceHostnameRecord,
} from '../../../features/install/instance-hostnames.ts'
import { base64urlEncode } from '../../../lib/encoding/base64url.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { verifyIdentityResponse } from '../../../lib/panel-identity/document.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../../lib/secrets/secrets.ts'
import { findIngressAccount, openAccountToken } from './accounts.ts'
import { capabilitiesFor } from './capabilities.ts'
import { readEdgeGate } from './gate.ts'
import type {
  ApplyResult,
  HostnameWithState,
  IngressContext,
  IngressDeps,
  IngressStatus,
  PreflightResult,
} from './provider.ts'
import {
  applyHostname,
  hostnameStatus,
  preflightHostname,
  removeHostnameIngress,
} from './registry.ts'

export const INSTANCE_ID_SETTING_KEY = 'INSTANCE_ID'

export type IngressServiceDeps = {
  dataEncryption: DerivedSecretsConfig
  secretsConfig: SecretsConfig | undefined
  registry: DaemonCellRegistry
  env: Record<string, string | undefined>
  /** The fingerprint this control plane signs with; the edge self-check compares against it. */
  selfKid: () => string | null
  fetch?: typeof fetch
  now?: () => Date
  /** Test seams; the real ones talk to the co-located daemon. */
  colocatedDaemonConnected?: IngressDeps['colocatedDaemonConnected']
  pushRunToken?: IngressDeps['pushRunToken']
}

type StoredIngress = {
  provider: Record<string, unknown> | null
  status: (IngressStatus & { checkedAt: string }) | null
  lastApply: { at: string; ok: boolean; cause?: string; detail?: string } | null
}

/** A plain function so the runtime's `fetch` keeps its receiver. */
export const networkFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Listener modes return `{}`: nothing was set up, so nothing must be disconnected later. */
function nonEmpty(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return value && Object.keys(value).length > 0 ? value : null
}

export function readStoredIngress(value: unknown): StoredIngress {
  const raw = asObject(value)
  return {
    provider: nonEmpty(asObject(raw?.provider)),
    status: (asObject(raw?.status) as StoredIngress['status']) ?? null,
    lastApply: (asObject(raw?.lastApply) as StoredIngress['lastApply']) ?? null,
  }
}

async function writeStoredIngress(db: Db, id: string, stored: StoredIngress | null): Promise<void> {
  await db.update(instanceHostname).set({ ingressState: stored }).where(eq(instanceHostname.id, id))
}

export async function loadHostnamesWithState(db: Db): Promise<HostnameWithState[]> {
  const records = await listInstanceHostnames(db)
  const states = await db
    .select({ id: instanceHostname.id, ingressState: instanceHostname.ingressState })
    .from(instanceHostname)
  const byId = new Map(states.map((row) => [row.id, readStoredIngress(row.ingressState).provider]))
  return records.map((record) => ({ ...record, providerState: byId.get(record.id) ?? null }))
}

/** A random id made once per install, for provider resource names. */
export async function ensureInstanceId(db: Db): Promise<string> {
  const read = async () =>
    (
      await db
        .select({ value: setting.value })
        .from(setting)
        .where(eq(setting.key, INSTANCE_ID_SETTING_KEY))
        .limit(1)
    )[0]?.value
  const existing = await read()
  if (typeof existing === 'string' && existing !== '') return existing
  const fresh = base64urlEncode(crypto.getRandomValues(new Uint8Array(12)))
  await db
    .insert(setting)
    .values({ key: INSTANCE_ID_SETTING_KEY, value: fresh })
    .onConflictDoNothing({ target: setting.key })
  const stored = await read()
  return typeof stored === 'string' ? stored : fresh
}

function ownIdentityCheck(deps: IngressServiceDeps): IngressDeps['isOwnIdentity'] {
  return async (body, header) => {
    const kid = deps.selfKid()
    if (!header || !kid) return false
    const verified = await verifyIdentityResponse(body, header)
    return verified.ok && verified.currentKid === kid
  }
}

async function colocatedConnected(db: Db, registry: DaemonCellRegistry): Promise<boolean> {
  const serverId = await resolveColocatedServerId(db, registry)
  if (!serverId) return false
  return (await registry.getSnapshots([serverId])).get(serverId)?.connected === true
}

/** The provider context for one hostname, or null when the row does not exist. */
export async function buildIngressContext(
  db: Db,
  hostnameId: string,
  deps: IngressServiceDeps
): Promise<IngressContext | null> {
  const hostnames = await loadHostnamesWithState(db)
  const hostname = hostnames.find((row) => row.id === hostnameId)
  if (!hostname) return null
  const ingressDeps: IngressDeps = {
    db,
    now: deps.now ?? (() => new Date()),
    fetch: deps.fetch ?? networkFetch,
    colocatedDaemonConnected:
      deps.colocatedDaemonConnected ?? (() => colocatedConnected(db, deps.registry)),
    pushRunToken:
      deps.pushRunToken ??
      ((token) =>
        dispatchInstanceTunnelToken({
          db,
          registry: deps.registry,
          token,
          secretsConfig: deps.secretsConfig,
        })),
    gate: await readEdgeGate(db, deps.env),
    account: hostname.ingressId ? await findIngressAccount(db, hostname.ingressId) : null,
    openToken: (account) => openAccountToken(db, deps.dataEncryption, account),
    hostnames,
    instanceId: await ensureInstanceId(db),
    isOwnIdentity: ownIdentityCheck(deps),
  }
  return { hostname, deps: ingressDeps }
}

async function storedFor(db: Db, id: string): Promise<StoredIngress> {
  const rows = await db
    .select({ ingressState: instanceHostname.ingressState })
    .from(instanceHostname)
    .where(eq(instanceHostname.id, id))
    .limit(1)
  return readStoredIngress(rows[0]?.ingressState)
}

export async function preflightIngress(
  db: Db,
  hostnameId: string,
  deps: IngressServiceDeps
): Promise<PreflightResult | null> {
  const ctx = await buildIngressContext(db, hostnameId, deps)
  return ctx ? await preflightHostname(ctx) : null
}

/** Run apply and keep its state; a refusal keeps the previous provider state. */
export async function applyIngress(
  db: Db,
  hostnameId: string,
  deps: IngressServiceDeps,
  options: { replaceExisting?: boolean } = {}
): Promise<ApplyResult | null> {
  const ctx = await buildIngressContext(db, hostnameId, deps)
  if (!ctx) return null
  const result = await applyHostname({ ...ctx, replaceExisting: options.replaceExisting })
  const at = (deps.now?.() ?? new Date()).toISOString()
  const previous = await storedFor(db, hostnameId)
  const stored: StoredIngress = result.ok
    ? {
        provider: result.state,
        status: { phase: 'applying', checkedAt: at },
        lastApply: { at, ok: true },
      }
    : { ...previous, lastApply: { at, ok: false, cause: result.cause, detail: result.detail } }
  await writeStoredIngress(db, hostnameId, stored)
  return result
}

/** Read the provider's health now and keep it for the screens. */
export async function ingressStatus(
  db: Db,
  hostnameId: string,
  deps: IngressServiceDeps
): Promise<IngressStatus | null> {
  const ctx = await buildIngressContext(db, hostnameId, deps)
  if (!ctx) return null
  const status = await hostnameStatus(ctx)
  const previous = await storedFor(db, hostnameId)
  if (previous.provider) {
    const checkedAt = (deps.now?.() ?? new Date()).toISOString()
    await writeStoredIngress(db, hostnameId, { ...previous, status: { ...status, checkedAt } })
  }
  return status
}

/** Take the provider setup down and forget its state. */
export async function removeIngress(
  db: Db,
  hostnameId: string,
  deps: IngressServiceDeps
): Promise<boolean> {
  const ctx = await buildIngressContext(db, hostnameId, deps)
  if (!ctx) return false
  await removeHostnameIngress(ctx)
  await writeStoredIngress(db, hostnameId, null)
  return true
}

/** Status refresh for the tick: every edge-mode name that has been applied. */
export async function refreshEdgeStatuses(db: Db, deps: IngressServiceDeps): Promise<void> {
  const rows = await loadHostnamesWithState(db)
  const applied = rows.filter((row) => row.providerState && capabilitiesFor(row.mode).isEdge)
  await forEachSequential(applied, (row) => ingressStatus(db, row.id, deps))
}

export type HostnameIngressInput = { mode?: unknown; ingressId?: unknown; publicPort?: unknown }
export type HostnameIngressUpdate =
  | { ok: true; hostname: InstanceHostnameRecord }
  | { ok: false; status: 404 | 409 | 422; error: string }

function invalid(error: string): HostnameIngressUpdate {
  return { ok: false, status: 422, error }
}

async function accountProblem(db: Db, mode: string, ingressId: unknown): Promise<string | null> {
  const provider = isIngressMode(mode) ? capabilitiesFor(mode).provider : null
  if (ingressId === null || ingressId === undefined) return null
  if (typeof ingressId !== 'string') return 'ingressId must be a string or null'
  if (!provider) return 'This connection mode uses no provider account.'
  const account = await findIngressAccount(db, ingressId)
  if (!account) return 'The provider account was not found.'
  return account.provider === provider ? null : `This connection mode needs a ${provider} account.`
}

/**
 * Change how visitors reach one name. A name whose provider setup is still
 * in place must be disconnected before its mode or account changes, so a
 * tunnel is never left behind without a row that knows about it.
 */
export async function setHostnameIngress(
  db: Db,
  hostnameId: string,
  input: HostnameIngressInput
): Promise<HostnameIngressUpdate> {
  const current = (await listInstanceHostnames(db)).find((row) => row.id === hostnameId)
  if (!current) return { ok: false, status: 404, error: 'Hostname not found' }
  const mode = input.mode ?? current.mode
  if (!isIngressMode(mode)) return invalid('mode must be a known connection mode')
  if (input.publicPort !== undefined && !isPublicPort(input.publicPort)) {
    return invalid('publicPort must be a whole number from 1 to 65535')
  }
  const ingressId = input.ingressId === undefined ? current.ingressId : input.ingressId
  const problem = await accountProblem(db, mode, ingressId)
  if (problem) return invalid(problem)
  const applied = (await storedFor(db, hostnameId)).provider !== null
  const changes = mode !== current.mode || ingressId !== current.ingressId
  if (applied && changes) {
    return {
      ok: false,
      status: 409,
      error: 'Disconnect this hostname before changing its mode or account.',
    }
  }
  const publicPort = (input.publicPort as number | undefined) ?? current.publicPort
  const nextIngressId = capabilitiesFor(mode).provider
    ? ((ingressId as string | null) ?? null)
    : null
  await db
    .update(instanceHostname)
    .set({ mode, publicPort, ingressId: nextIngressId })
    .where(eq(instanceHostname.id, hostnameId))
  return { ok: true, hostname: { ...current, mode, publicPort, ingressId: nextIngressId } }
}
