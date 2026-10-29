/**
 * The Cloudflare tunnel adapter, built on the small client. Credentials are
 * checked with read calls only (accounts, zones, tunnels, DNS records): a
 * read that succeeds proves the token reaches that area, and edit rights are
 * confirmed by the first write that needs them.
 */
import {
  type BadgeCapabilities,
  type DeclaredZone,
  type TokenInfo,
  type TokenKind,
  UNKNOWN_TOKEN,
} from './vocabulary.ts'
import type { CredentialReport, DeclaredZoneResult, TunnelAdapter } from './adapter.ts'
import { CloudflareClient, type CloudflareIngressRule } from './cloudflare-client.ts'
import { TunnelProviderError } from './errors.ts'

/** Names of the permissions a token needs, as Cloudflare words them. */
export const CLOUDFLARE_PERMISSIONS = {
  tunnels: 'Account · Cloudflare Tunnel · Edit',
  dns: 'Zone · DNS · Edit',
  certificates: 'Zone · SSL and Certificates · Edit',
} as const

/** What a connector is told to reach: the web server on the same machine. */
const LOCAL_ORIGIN = 'https://localhost'

function requireAccount(accountId: string | null): string {
  if (!accountId) throw new TypeError('A Cloudflare account id is required')
  return accountId
}

/** Cloudflare permission failures are 401 or 403; anything else is not a missing permission. */
function isPermissionFailure(err: unknown): boolean {
  return (
    err instanceof TunnelProviderError && (err.code === 'forbidden' || err.code === 'unauthorized')
  )
}

/** Run a read probe: true when it works, false when the token lacks access, rethrow anything else. */
async function probe(read: () => Promise<void>): Promise<boolean> {
  try {
    await read()
    return true
  } catch (err) {
    if (isPermissionFailure(err)) return false
    throw err
  }
}

/** A list the token may not be allowed to read counts as empty; a rejected token still fails. */
async function listOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read()
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code === 'forbidden') return []
    throw err
  }
}

/** The zones whose DNS records the token can read, found by one safe read per zone. */
async function reachableZones(
  api: CloudflareClient,
  zones: readonly { id: string; name: string }[]
): Promise<{ id: string; name: string }[]> {
  const probed = await Promise.all(
    zones.map(async (z) =>
      (await probe(() => api.probeDns(z.id))) ? { id: z.id, name: z.name } : null
    )
  )
  return probed.filter((z): z is { id: string; name: string } => z !== null)
}

/** The zones whose origin certificates the token can read, found by one safe read per zone. */
async function reachableCertificateZones(
  api: CloudflareClient,
  zones: readonly { id: string; name: string }[]
): Promise<{ id: string; name: string }[]> {
  // The certificate list answers 404 or 400 as well as 403 to a token without the permission.
  const readable = async (zoneId: string): Promise<boolean> => {
    try {
      return await probe(() => api.probeCertificates(zoneId))
    } catch (err) {
      if (err instanceof TunnelProviderError && (err.code === 'not_found' || err.status === 400)) {
        return false
      }
      throw err
    }
  }
  const probed = await Promise.all(
    zones.map(async (z) => ((await readable(z.id)) ? { id: z.id, name: z.name } : null))
  )
  return probed.filter((z): z is { id: string; name: string } => z !== null)
}

/**
 * A zone the person named: a zone the token is not allowed to read, one that does
 * not exist, or an id the provider calls invalid all mean "not reachable"; an
 * outage or any other failure is still an error.
 */
async function probeNamedZone(api: CloudflareClient, zoneId: string): Promise<boolean> {
  try {
    await api.probeDns(zoneId)
    return true
  } catch (err) {
    if (!(err instanceof TunnelProviderError)) throw err
    if (isPermissionFailure(err) || err.code === 'not_found' || err.status === 400) return false
    throw err
  }
}

/**
 * Check zones the person named. A token limited to one zone is usually refused
 * the zone list, so the zone's id is probed directly with a DNS read. The zone's
 * own name and account come from a zone read when the token may make one; a
 * token without Zone · Zone · Read falls back to the name the person typed.
 */
async function checkDeclaredZones(
  api: CloudflareClient,
  declared: readonly DeclaredZone[],
  accountId: string | null
): Promise<DeclaredZoneResult[]> {
  return await Promise.all(
    declared.map(async (z) => {
      const reachable = await probeNamedZone(api, z.id)
      if (!reachable) return { id: z.id, name: z.name || null, reachable, accountMatch: null }
      let found: { name?: string; account?: { id?: string } } | null = null
      try {
        found = await api.getZone(z.id)
      } catch (err) {
        if (!isPermissionFailure(err) && !(err instanceof TunnelProviderError)) throw err
      }
      const owner = found?.account?.id
      return {
        id: z.id,
        name: found?.name ?? (z.name || null),
        reachable,
        accountMatch: accountId && owner ? owner === accountId : null,
      }
    })
  )
}

/** Zones found by listing, plus declared zones that were reached on this account. */
function mergeZones(
  listed: readonly { id: string; name: string }[],
  declared: readonly DeclaredZoneResult[]
): { id: string; name: string }[] {
  const byId = new Map(listed.map((z) => [z.id, z]))
  for (const z of declared) {
    if (z.reachable && z.name && z.accountMatch !== false && !byId.has(z.id)) {
      byId.set(z.id, { id: z.id, name: z.name })
    }
  }
  return [...byId.values()]
}

/**
 * A Global API Key is a different credential (it needs an email and is not a
 * bearer token). Legacy keys are 37 to 45 lowercase hex characters and new ones
 * start with `cfk_`. API tokens are 40 alphanumeric characters or start with
 * `cfut_` (user-owned) or `cfat_` (account-owned).
 */
export function cloudflareTokenProblem(token: string): string | null {
  if (token.startsWith('cfk_') || /^[0-9a-f]{37,45}$/.test(token)) {
    return 'This looks like a Global API Key, which does not work here. Create an API Token in Cloudflare and paste that instead.'
  }
  return null
}

function kindFromPrefix(token: string): TokenKind | null {
  if (token.startsWith('cfat_')) return 'account'
  if (token.startsWith('cfut_')) return 'user'
  return null
}

type VerifyResult = { id?: string; status?: string; expires_on?: string }

/** Run one verify call; a refusal means "not this kind", anything else is a real failure. */
async function tryVerify(call: () => Promise<VerifyResult>): Promise<VerifyResult | null> {
  try {
    return await call()
  } catch (err) {
    if (
      err instanceof TunnelProviderError &&
      (err.code === 'unauthorized' || err.code === 'forbidden' || err.code === 'not_found')
    ) {
      return null
    }
    throw err
  }
}

/**
 * Ask Cloudflare about the token itself. An account-owned token is verified at
 * the account endpoint and a user-owned one at the user endpoint, so the one
 * that fits is tried first (by prefix, else by whether an account is known)
 * and the other is the fallback. A token that verifies nowhere is reported as
 * unknown, not rejected: the probes decide what it can do.
 */
async function inspectToken(
  api: CloudflareClient,
  token: string,
  accountIds: readonly string[]
): Promise<TokenInfo> {
  const prefix = kindFromPrefix(token)
  const asAccount = async (): Promise<TokenInfo | null> => {
    for (const id of accountIds) {
      const found = await tryVerify(() => api.verifyAccountToken(id))
      if (found) return toInfo('account', found)
    }
    return null
  }
  const asUser = async (): Promise<TokenInfo | null> => {
    const found = await tryVerify(() => api.verifyUserToken())
    return found ? toInfo('user', found) : null
  }
  const accountFirst = prefix === 'account' || (prefix === null && accountIds.length === 1)
  const order = accountFirst ? [asAccount, asUser] : [asUser, asAccount]
  for (const attempt of order) {
    const info = await attempt()
    if (info) return prefix ? { ...info, kind: prefix } : info
  }
  return { ...UNKNOWN_TOKEN, kind: prefix }
}

function toInfo(kind: TokenKind, found: VerifyResult): TokenInfo {
  return {
    kind,
    id: found.id ?? null,
    status: found.status ?? null,
    expiresAt: found.expires_on ?? null,
  }
}

/** `parseExpiry` for a list item: an unreadable or missing time is null, not an error. */
function safeExpiry(value: string | undefined): string | null {
  if (!value) return null
  try {
    return parseExpiry(value)
  } catch {
    return null
  }
}

/**
 * Cloudflare writes expiry as `2026-11-04 17:43:00 +0000 UTC`; an ISO time is
 * accepted too. Anything else is a provider error, not a guess.
 */
export function parseExpiry(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?: \+0000 UTC|Z)?$/.exec(
    value.trim()
  )
  const time = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN
  if (Number.isNaN(time)) {
    throw new TunnelProviderError(
      'provider_error',
      'Cloudflare gave an expiry time it could not be read',
      null
    )
  }
  return new Date(time).toISOString()
}

export function buildIngress(
  hostnames: readonly string[],
  verifyOrigin = false
): CloudflareIngressRule[] {
  const seen = new Set<string>()
  const rules: CloudflareIngressRule[] = []
  for (const raw of hostnames) {
    const hostname = raw.trim().toLowerCase()
    if (hostname.length === 0 || seen.has(hostname)) continue
    seen.add(hostname)
    rules.push({
      hostname,
      service: LOCAL_ORIGIN,
      originRequest: {
        httpHostHeader: hostname,
        originServerName: hostname,
        noTLSVerify: !verifyOrigin,
      },
    })
  }
  // The last rule must match everything and carry no hostname.
  rules.push({ service: 'http_status:404' })
  return rules
}

export function createCloudflareAdapter(options: { fetch?: typeof fetch } = {}): TunnelAdapter {
  const client = (token: string) => new CloudflareClient({ token, fetch: options.fetch })
  return {
    provider: 'cloudflare',

    tokenShapeProblem: cloudflareTokenProblem,

    async discoverAccounts(token) {
      const api = client(token)
      const accounts = await listOrEmpty(() => api.listAccounts())
      const info = await inspectToken(
        api,
        token,
        accounts.map((a) => a.id)
      )
      return { accounts: accounts.map((a) => ({ id: a.id, name: a.name })), token: info }
    },

    async checkCredential(token, scope): Promise<CredentialReport> {
      const api = client(token)
      // A token scoped to tunnels and DNS only may be refused the account and zone
      // lists; that is not a bad token, so the probes below decide what it can do.
      const accounts = await listOrEmpty(() => api.listAccounts())
      const zones = await listOrEmpty(() => api.listZones(scope.accountId))
      const accountVisible =
        scope.accountId === null ||
        accounts.length === 0 ||
        accounts.some((a) => a.id === scope.accountId)
      const tokenInfo = await inspectToken(
        api,
        token,
        scope.accountId ? [scope.accountId] : accounts.map((a) => a.id)
      )
      const tunnels =
        accountVisible && scope.accountId !== null
          ? await probe(() => api.probeTunnels(scope.accountId!))
          : false
      // DNS rights can be limited to some zones, so each zone is probed on its own.
      const declared = await checkDeclaredZones(api, scope.declaredZones ?? [], scope.accountId)
      const dns = mergeZones(await reachableZones(api, zones), declared)
      const capabilities: BadgeCapabilities = {
        tunnels,
        dns,
        // Certificate rights are per zone too, proved by one safe read of the zone's list.
        certificates: await reachableCertificateZones(api, mergeZones(zones, declared)),
      }
      const missing: string[] = []
      if (!tunnels) missing.push(CLOUDFLARE_PERMISSIONS.tunnels)
      if (dns.length === 0) missing.push(CLOUDFLARE_PERMISSIONS.dns)
      return {
        accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        zones: zones.map((z) => ({ id: z.id, name: z.name })),
        accountVisible,
        capabilities,
        missing,
        token: tokenInfo,
        declared,
      }
    },

    async createTunnel(token, input) {
      const api = client(token)
      const account = requireAccount(input.accountId)
      const created = await api.createTunnel(account, input.name)
      const runToken =
        typeof created.token === 'string' && created.token.length > 0
          ? created.token
          : await api.getTunnelToken(account, created.id)
      return { externalId: created.id, runToken }
    },

    fetchRunToken(token, input) {
      return client(token).getTunnelToken(requireAccount(input.accountId), input.externalId)
    },

    rotateRunToken() {
      // Cloudflare's way to issue a fresh run token is not confirmed yet, so nothing is guessed.
      return Promise.reject(
        new TunnelProviderError(
          'unsupported',
          'Rotating a Cloudflare run token is not supported yet',
          null
        )
      )
    },

    async setRoutes(token, input) {
      await client(token).putConfiguration(
        requireAccount(input.accountId),
        input.externalId,
        buildIngress(input.hostnames, input.verifyOrigin)
      )
    },

    async findZone(token, input) {
      const account = requireAccount(input.accountId)
      const name = input.hostname.trim().toLowerCase()
      // Only this account's zones are searched, and a zone that reports another
      // account is ignored: a CNAME to a tunnel works only inside one account.
      const api = client(token)
      const zones = (await api.listZones(account)).filter(
        (z) => z.account?.id === undefined || z.account.id === account
      )
      const candidates = zones
        .filter((z) => name === z.name || name.endsWith(`.${z.name}`))
        .sort((a, b) => b.name.length - a.name.length)
      // The longest matching zone this token can reach wins.
      for (const zone of candidates) {
        if (await probe(() => api.probeDns(zone.id))) return { id: zone.id, name: zone.name }
      }
      throw new TunnelProviderError(
        'zone_not_found',
        `No zone for ${input.hostname} that this token can reach was found in this Cloudflare account`,
        null
      )
    },

    async createDnsName(token, input) {
      const record = await client(token).createDnsRecord(input.zoneId, {
        name: input.hostname,
        content: `${input.externalId}.cfargotunnel.com`,
      })
      return { recordId: record.id }
    },

    async removeDnsName(token, input) {
      await client(token).deleteDnsRecord(input.zoneId, input.recordId)
    },

    async deleteTunnel(token, input) {
      await client(token).deleteTunnel(requireAccount(input.accountId), input.externalId)
    },

    async issueOriginCertificate(token, input) {
      const issued = await client(token).createOriginCertificate({
        hostnames: input.hostnames,
        csr: input.csrPem,
        validityDays: input.validityDays,
      })
      if (!issued.certificate || !issued.expires_on) {
        throw new TunnelProviderError(
          'provider_error',
          'Cloudflare answered without a certificate',
          null
        )
      }
      return {
        externalId: issued.id,
        certificatePem: issued.certificate,
        notAfter: parseExpiry(issued.expires_on),
      }
    },

    async listOriginCertificates(token, input) {
      const list = await client(token).listOriginCertificates(input.zoneId)
      return list.map((item) => ({
        externalId: item.id,
        hostnames: (item.hostnames ?? []).map((name) => name.trim().toLowerCase()),
        notAfter: safeExpiry(item.expires_on),
        certificatePem: item.certificate ?? null,
      }))
    },

    async revokeOriginCertificate(token, input) {
      await client(token).revokeOriginCertificate(input.externalId)
    },
  }
}
