/**
 * The install-level Cloudflare account: check a pasted API token (verify plus
 * one read per scope; Cloudflare has no call that lists a token's
 * permissions), store it sealed, recheck it and remove it. The token never
 * reaches a log, a response, an audit row or `last_error`.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../../../db/connection.ts'
import { ingressAccount, instanceHostname } from '../../../../db/schema.ts'
import {
  CloudflareClient,
  type CloudflareZone,
} from '../../../../features/tunnels/cloudflare-client.ts'
import { clip, scrubSecrets } from '../../../../features/tunnels/scrub.ts'
import { firstSequential } from '../../../../lib/sequential.ts'
import { encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import type { AccountScopes, IngressAccountRecord, ProviderZone } from '../accounts.ts'
import { findIngressAccount, openAccountToken } from '../accounts.ts'
import type { PreflightCheck } from '../provider.ts'
import { check } from '../planner.ts'

export type CloudflarePreflight = {
  ok: boolean
  checks: PreflightCheck[]
  accountId: string | null
  zones: ProviderZone[]
  expiresOn: string | null
}

type Verified = { expiresOn: string | null; accountIds: string[] }

const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000
/** Enough for an install's own names; a token that sees hundreds of zones is too wide anyway. */
const MAX_ZONES_PROBED = 25
const MAX_LABEL = 80

function failure(err: unknown, token: string): string {
  const text = err instanceof Error ? err.message : String(err)
  return clip(scrubSecrets(text, [token]), 200)
}

/** Shape problems Cloudflare would refuse anyway, in plain words; null when the text looks like an API token. */
export function cloudflareTokenShapeProblem(token: string): string | null {
  if (token.trim() === '') return 'Paste a Cloudflare API token.'
  if (token.startsWith('cfk_') || /^[0-9a-f]{37,45}$/.test(token)) {
    return 'This looks like a Global API Key. Create an API token in Cloudflare and paste that instead.'
  }
  return null
}

async function tryVerify(
  call: () => Promise<{ status?: string; expires_on?: string }>
): Promise<string | null | undefined> {
  try {
    const result = await call()
    if (result.status !== undefined && result.status !== 'active') return undefined
    return result.expires_on ?? null
  } catch {
    return undefined
  }
}

/**
 * Whether Cloudflare accepts the token. A user token (`cfut_`) verifies at the
 * user endpoint, an account token (`cfat_`) at its account; an older token
 * without a prefix is tried both ways.
 */
async function verifyToken(api: CloudflareClient, token: string): Promise<Verified | null> {
  const accounts = await api.listAccounts().catch(() => [])
  const accountIds = accounts.map((account) => account.id)
  const userFirst = token.startsWith('cfat_') ? [] : [() => api.verifyUserToken()]
  const calls = [...userFirst, ...accountIds.map((id) => () => api.verifyAccountToken(id))]
  const found = await firstSequential(calls, async (call) => {
    const expiresOn = await tryVerify(call)
    return expiresOn === undefined ? undefined : { expiresOn }
  })
  return found ? { expiresOn: found.expiresOn, accountIds } : null
}

async function firstTunnelAccount(api: CloudflareClient, ids: string[]): Promise<string | null> {
  // The token may cover several accounts: the first that lists tunnels wins.
  const found = await firstSequential(ids, (id) =>
    api.probeTunnels(id).then(
      () => id,
      () => undefined
    )
  )
  return found ?? null
}

async function writableZones(
  api: CloudflareClient,
  zones: CloudflareZone[]
): Promise<ProviderZone[]> {
  const probed = await Promise.all(
    zones.slice(0, MAX_ZONES_PROBED).map(async (zone) => {
      try {
        await api.probeDns(zone.id)
        return [{ id: zone.id, name: zone.name.toLowerCase() }]
      } catch {
        return []
      }
    })
  )
  return probed.flat()
}

function expiryCheck(expiresOn: string | null, now: Date): PreflightCheck {
  if (!expiresOn) return check('token-expiry', true, 'The token does not expire.')
  const at = Date.parse(expiresOn)
  const soon = !Number.isNaN(at) && at - now.getTime() < EXPIRY_WARNING_MS
  const date = expiresOn.slice(0, 10)
  return soon
    ? check('token-expiry', false, `The token expires on ${date}. Use a token that lasts longer.`)
    : check('token-expiry', true, `The token expires on ${date}.`)
}

function emptyPreflight(checks: PreflightCheck[]): CloudflarePreflight {
  return { ok: false, checks, accountId: null, zones: [], expiresOn: null }
}

/** Every check a token must pass before it is stored. Never throws for a provider refusal. */
export async function preflightCloudflareToken(
  token: string,
  fetchImpl: typeof fetch,
  now: Date = new Date()
): Promise<CloudflarePreflight> {
  const shape = cloudflareTokenShapeProblem(token)
  if (shape) return emptyPreflight([check('token-shape', false, shape)])
  const api = new CloudflareClient({ token, fetch: fetchImpl })
  try {
    const verified = await verifyToken(api, token)
    if (!verified) {
      return emptyPreflight([
        check('token-verify', false, 'Cloudflare did not accept this token, or it is not active.'),
      ])
    }
    const accountId = await firstTunnelAccount(api, verified.accountIds)
    const zones = await writableZones(api, accountId ? await api.listZones(accountId) : [])
    const checks = [
      check('token-verify', true, 'Cloudflare accepted the token.'),
      accountId
        ? check('scope-tunnels', true, 'The token can manage tunnels.')
        : check(
            'scope-tunnels',
            false,
            'The token cannot manage tunnels (Account › Cloudflare Tunnel › Edit).'
          ),
      zones.length > 0
        ? check(
            'scope-dns',
            true,
            `The token can edit DNS in ${zones.map((zone) => zone.name).join(', ')}.`
          )
        : check(
            'scope-dns',
            false,
            'The token cannot edit DNS records in any zone (Zone › DNS › Edit).'
          ),
      expiryCheck(verified.expiresOn, now),
    ]
    return {
      ok: checks.every((item) => item.ok),
      checks,
      accountId,
      zones,
      expiresOn: verified.expiresOn,
    }
  } catch (err) {
    return emptyPreflight([check('provider', false, failure(err, token))])
  }
}

export function scopesFrom(preflight: CloudflarePreflight, now: Date): AccountScopes {
  const ok = (id: string) => preflight.checks.some((item) => item.id === id && item.ok)
  return {
    tunnels: ok('scope-tunnels'),
    dns: ok('scope-dns'),
    checkedAt: now.toISOString(),
    zones: preflight.zones,
    expiresOn: preflight.expiresOn,
  }
}

export type AccountDeps = {
  dataEncryption: DerivedSecretsConfig
  fetch: typeof fetch
  now?: () => Date
}

export type SaveAccountResult =
  | { ok: true; id: string; preflight: CloudflarePreflight }
  | { ok: false; status: 422; error: string; preflight: CloudflarePreflight | null }

/** Check the token and store it sealed; a token that fails any check is not stored. */
export async function saveIngressAccount(
  db: Db,
  input: { label: string; token: string; createdByUserId: string | null },
  deps: AccountDeps
): Promise<SaveAccountResult> {
  const label = input.label.trim()
  if (label === '' || label.length > MAX_LABEL) {
    return {
      ok: false,
      status: 422,
      error: `Give the account a label of 1 to ${MAX_LABEL} characters.`,
      preflight: null,
    }
  }
  const now = deps.now?.() ?? new Date()
  const preflight = await preflightCloudflareToken(input.token, deps.fetch, now)
  if (!preflight.ok) {
    return { ok: false, status: 422, error: 'The token did not pass every check.', preflight }
  }
  const rows = await db
    .insert(ingressAccount)
    .values({
      provider: 'cloudflare',
      label,
      accountId: preflight.accountId,
      zoneIds: preflight.zones.map((zone) => zone.id),
      tokenEnvelope: await encryptSecret(deps.dataEncryption, input.token),
      scopes: scopesFrom(preflight, now),
      lastVerifiedAt: now.toISOString(),
      lastError: null,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: ingressAccount.id })
  return { ok: true, id: rows[0]!.id, preflight }
}

export type RemoveAccountResult = { ok: true } | { ok: false; error: 'in-use'; hostnames: string[] }

/** Refused while a hostname still uses the account: disconnect those first. */
export async function removeIngressAccount(db: Db, id: string): Promise<RemoveAccountResult> {
  const users = await db
    .select({ host: instanceHostname.host })
    .from(instanceHostname)
    .where(eq(instanceHostname.ingressId, id))
  if (users.length > 0) {
    return { ok: false, error: 'in-use', hostnames: users.map((row) => row.host) }
  }
  await db.delete(ingressAccount).where(eq(ingressAccount.id, id))
  return { ok: true }
}

/** Run the token checks again and store the result; `null` when the account is gone. */
export async function recheckIngressAccount(
  db: Db,
  id: string,
  deps: AccountDeps
): Promise<CloudflarePreflight | null> {
  const account = await findIngressAccount(db, id)
  if (!account) return null
  const now = deps.now?.() ?? new Date()
  const token = await openAccountToken(db, deps.dataEncryption, account)
  const preflight = await preflightCloudflareToken(token, deps.fetch, now)
  const failed = preflight.checks.find((item) => !item.ok)
  await db
    .update(ingressAccount)
    .set({
      scopes: scopesFrom(preflight, now),
      lastError: failed ? failed.detail : null,
      ...(preflight.ok ? { lastVerifiedAt: now.toISOString() } : {}),
      ...(preflight.ok ? { zoneIds: preflight.zones.map((zone) => zone.id) } : {}),
    })
    .where(eq(ingressAccount.id, id))
  return preflight
}

/** Accounts whose last good check is older than a day, for the daily recheck. */
export function accountsDueForRecheck(
  accounts: readonly IngressAccountRecord[],
  now: Date
): IngressAccountRecord[] {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000
  return accounts.filter((account) => {
    const last = Date.parse(account.scopes?.checkedAt ?? '')
    return Number.isNaN(last) || last < dayAgo
  })
}
