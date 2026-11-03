/**
 * The install-level Cloudflare account: check a pasted API token (verify, then
 * read the token's own policies and evaluate them in `token-policies.ts`),
 * store it sealed, recheck it and remove it. The token never reaches a log, a
 * response, an audit row or `last_error`.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../../../db/connection.ts'
import { ingressAccount, instanceHostname } from '../../../../db/schema.ts'
import {
  CloudflareClient,
  type CloudflareTokenVerify,
} from '../../../../features/tunnels/cloudflare-client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import { clip, scrubSecrets } from '../../../../features/tunnels/scrub.ts'
import { firstSequential } from '../../../../lib/sequential.ts'
import { encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import type { AccountScopes, IngressAccountRecord, ProviderZone } from '../accounts.ts'
import { findIngressAccount, openAccountToken } from '../accounts.ts'
import type { PreflightCheck } from '../provider.ts'
import { check } from '../planner.ts'
import {
  type CloudflareTokenPolicy,
  dnsGrant,
  type DnsGrant,
  tunnelGrant,
  type TunnelGrant,
} from './token-policies.ts'

export type CloudflarePreflight = {
  ok: boolean
  checks: PreflightCheck[]
  accountId: string | null
  zones: ProviderZone[]
  expiresOn: string | null
}

/** Who owns the token, which decides where it can read itself. */
type TokenOwner = { kind: 'user' } | { kind: 'account'; accountId: string }

type Verified = {
  expiresOn: string | null
  tokenId: string | null
  owner: TokenOwner
  accountIds: string[]
}

const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000
const MAX_LABEL = 80
/** Zone names spelled out in one message; the rest are counted. */
const MAX_NAMED_ZONES = 10

const POLICY_READ_PERMISSION: Record<TokenOwner['kind'], string> = {
  account: 'Account › Account API Tokens › Read',
  user: 'User › API Tokens › Read',
}

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
  call: () => Promise<CloudflareTokenVerify>
): Promise<{ expiresOn: string | null; tokenId: string | null } | undefined> {
  try {
    const result = await call()
    if (result.status !== undefined && result.status !== 'active') return undefined
    return { expiresOn: result.expires_on ?? null, tokenId: result.id ?? null }
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
  type Attempt = { owner: TokenOwner; call: () => Promise<CloudflareTokenVerify> }
  const userFirst: Attempt[] = token.startsWith('cfat_')
    ? []
    : [{ owner: { kind: 'user' }, call: () => api.verifyUserToken() }]
  const attempts: Attempt[] = [
    ...userFirst,
    ...accountIds.map((id): Attempt => ({
      owner: { kind: 'account', accountId: id },
      call: () => api.verifyAccountToken(id),
    })),
  ]
  const found = await firstSequential(attempts, async (attempt) => {
    const result = await tryVerify(attempt.call)
    return result === undefined ? undefined : { ...result, owner: attempt.owner }
  })
  return found ? { ...found, accountIds } : null
}

/** The token's own policies; null when it may not read itself. */
async function readPolicies(
  api: CloudflareClient,
  verified: Verified
): Promise<CloudflareTokenPolicy[] | null> {
  const { tokenId, owner } = verified
  if (!tokenId) return null
  try {
    const detail =
      owner.kind === 'user'
        ? await api.getUserToken(tokenId)
        : await api.getAccountToken(owner.accountId, tokenId)
    return Array.isArray(detail.policies) ? (detail.policies as CloudflareTokenPolicy[]) : []
  } catch (err) {
    const refused = ['forbidden', 'unauthorized', 'not_found']
    if (err instanceof TunnelProviderError && refused.includes(err.code)) return null
    throw err
  }
}

/** The account the tunnel lives in: the owner's for an account token, else the first with Tunnel Edit. */
function chooseAccount(policies: CloudflareTokenPolicy[], verified: Verified): string | null {
  const ids = verified.owner.kind === 'account' ? [verified.owner.accountId] : verified.accountIds
  return ids.find((id) => tunnelGrant(policies, id).kind === 'account') ?? ids[0] ?? null
}

/** "a", "a and b", "a, b and c"; past the cap the rest are counted. */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_ZONES)
  const rest = names.length - shown.length
  const items = rest > 0 ? [...shown, `${rest} more`] : shown
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function zoneLabel(zoneIds: readonly string[], zones: readonly ProviderZone[]): string {
  const names = zoneIds.map((id) => zones.find((zone) => zone.id === id)?.name ?? id)
  const noun = names.length === 1 ? 'zone' : 'zones'
  return `the ${listNames(names)} ${noun}`
}

export function tunnelCheck(grant: TunnelGrant, zones: readonly ProviderZone[]): PreflightCheck {
  switch (grant.kind) {
    case 'account':
      return check('scope-tunnels', true, 'Cloudflare Tunnel Edit is granted on the account.')
    case 'denied':
      return check(
        'scope-tunnels',
        false,
        'A deny policy on the token takes Cloudflare Tunnel Edit away from the account. Remove that policy.'
      )
    case 'zone-only': {
      const where =
        grant.zoneIds.length > 0 ? zoneLabel(grant.zoneIds, zones) : 'the zones of the account'
      return check(
        'scope-tunnels',
        false,
        `Cloudflare Tunnel Edit is only granted on ${where}. Give it to the account instead.`
      )
    }
    case 'missing':
      return check(
        'scope-tunnels',
        false,
        'The token does not have Cloudflare Tunnel Edit on the account (Account › Cloudflare Tunnel › Edit).'
      )
  }
}

export function dnsCheck(grant: DnsGrant): PreflightCheck {
  if (grant.denied) {
    return check(
      'scope-dns',
      false,
      'A deny policy on the token takes DNS Edit away from every zone it was granted on. Remove that policy.'
    )
  }
  if (grant.zones.length === 0) {
    return check(
      'scope-dns',
      false,
      'The token cannot edit DNS records in any zone (Zone › DNS › Edit).'
    )
  }
  const names = listNames(grant.zones.map((zone) => zone.name))
  const these = grant.zones.length === 1 ? 'this zone' : 'these zones'
  const issued = `DNS-01 certificates are issued only for names in ${these}.`
  return grant.allZones
    ? check(
        'scope-dns',
        true,
        `The token can edit DNS in every zone of the account, more than the control plane needs: ${names}. ${issued}`
      )
    : check('scope-dns', true, `The token can edit DNS in ${names}. ${issued}`)
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

function finish(
  checks: PreflightCheck[],
  rest: Omit<CloudflarePreflight, 'ok' | 'checks'>
): CloudflarePreflight {
  return { ok: checks.every((item) => item.ok), checks, ...rest }
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
    const accepted = check('token-verify', true, 'Cloudflare accepted the token.')
    const expiry = expiryCheck(verified.expiresOn, now)
    const policies = await readPolicies(api, verified)
    if (!policies) {
      const permission = POLICY_READ_PERMISSION[verified.owner.kind]
      const detail = `The token cannot read its own permissions. Add ${permission} to the token.`
      return finish([accepted, check('token-policies', false, detail), expiry], {
        accountId: verified.owner.kind === 'account' ? verified.owner.accountId : null,
        zones: [],
        expiresOn: verified.expiresOn,
      })
    }
    const accountId = chooseAccount(policies, verified)
    const accountZones = accountId ? await api.listZones(accountId) : []
    const zones = accountZones.map((zone) => ({ id: zone.id, name: zone.name.toLowerCase() }))
    const dns = accountId ? dnsGrant(policies, accountId, zones) : null
    const checks = [
      accepted,
      check('token-policies', true, 'The token can read its own permissions.'),
      tunnelCheck(accountId ? tunnelGrant(policies, accountId) : { kind: 'missing' }, zones),
      dnsCheck(dns ?? { zones: [], allZones: false, denied: false }),
      expiry,
    ]
    return finish(checks, { accountId, zones: dns?.zones ?? [], expiresOn: verified.expiresOn })
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

/**
 * The scopes a recheck stores. A token stored before the policy check may
 * lack the permission to read itself: the last answer is kept (with the new
 * check time) so its names keep working, and `last_error` says what to add.
 */
export function recheckedScopes(
  previous: AccountScopes | null,
  preflight: CloudflarePreflight,
  now: Date
): AccountScopes {
  const unreadable = preflight.checks.some((item) => item.id === 'token-policies' && !item.ok)
  if (unreadable && previous) {
    return { ...previous, checkedAt: now.toISOString(), expiresOn: preflight.expiresOn }
  }
  return scopesFrom(preflight, now)
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
      scopes: recheckedScopes(account.scopes, preflight, now),
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
