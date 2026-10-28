/**
 * The Cloudflare tunnel adapter, built on the small client. Credentials are
 * checked with read calls only (accounts, zones, tunnels, DNS records): a
 * read that succeeds proves the token reaches that area, and edit rights are
 * confirmed by the first write that needs them.
 */
import type { BadgeCapability } from './vocabulary.ts'
import type { CredentialReport, TunnelAdapter } from './adapter.ts'
import { CloudflareClient, type CloudflareIngressRule } from './cloudflare-client.ts'
import { TunnelProviderError } from './errors.ts'

/** Names of the permissions a token needs, as Cloudflare words them. */
export const CLOUDFLARE_PERMISSIONS = {
  tunnels: 'Account · Cloudflare Tunnel · Edit',
  dns: 'Zone · DNS · Edit',
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

export function buildIngress(hostnames: readonly string[]): CloudflareIngressRule[] {
  const seen = new Set<string>()
  const rules: CloudflareIngressRule[] = []
  for (const raw of hostnames) {
    const hostname = raw.trim().toLowerCase()
    if (hostname.length === 0 || seen.has(hostname)) continue
    seen.add(hostname)
    rules.push({
      hostname,
      service: LOCAL_ORIGIN,
      originRequest: { httpHostHeader: hostname, originServerName: hostname, noTLSVerify: true },
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
      const tunnels =
        accountVisible && scope.accountId !== null
          ? await probe(() => api.probeTunnels(scope.accountId!))
          : false
      const dns = zones.length > 0 ? await probe(() => api.probeDns(zones[0]!.id)) : false
      const capabilities: Record<BadgeCapability, boolean> = {
        tunnels,
        dns,
        // No safe read proves certificate rights, so it is reported as not shown.
        certificates: false,
      }
      const missing: string[] = []
      if (!tunnels) missing.push(CLOUDFLARE_PERMISSIONS.tunnels)
      if (!dns) missing.push(CLOUDFLARE_PERMISSIONS.dns)
      return {
        accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        zones: zones.map((z) => ({ id: z.id, name: z.name })),
        accountVisible,
        capabilities,
        missing,
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
        buildIngress(input.hostnames)
      )
    },

    async findZone(token, input) {
      const account = requireAccount(input.accountId)
      const name = input.hostname.trim().toLowerCase()
      // Only this account's zones are searched, and a zone that reports another
      // account is ignored: a CNAME to a tunnel works only inside one account.
      const zones = (await client(token).listZones(account)).filter(
        (z) => z.account?.id === undefined || z.account.id === account
      )
      const match = zones
        .filter((z) => name === z.name || name.endsWith(`.${z.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0]
      if (!match) {
        throw new TunnelProviderError(
          'zone_not_found',
          `No zone for ${input.hostname} was found in this Cloudflare account`,
          null
        )
      }
      return { id: match.id, name: match.name }
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
  }
}
