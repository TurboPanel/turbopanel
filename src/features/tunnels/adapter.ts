import type { BadgeCapabilities, TunnelProvider } from './vocabulary.ts'

export type ProviderAccount = { id: string; name: string }
export type ProviderZone = { id: string; name: string }

/** What a credential check found, from read calls only. */
export type CredentialReport = {
  accounts: ProviderAccount[]
  zones: ProviderZone[]
  /** The carrier's own account is among the accounts the token can see. */
  accountVisible: boolean
  /** What read calls proved the token reaches: tunnels account-wide, DNS per zone. */
  capabilities: BadgeCapabilities
  /** Plain-words names of the permissions a useful token still lacks. */
  missing: string[]
}

export type TunnelCreated = { externalId: string; runToken: string }

/**
 * One adapter per tunnel provider. Every method takes the credential as an
 * argument and never keeps it; errors are `TunnelProviderError`, already
 * scrubbed. Adding a provider means a new adapter and a new member in the
 * provider list, with no change to the tables.
 */
export type TunnelAdapter = {
  readonly provider: TunnelProvider
  /** Check a credential with safe read calls and report what it reaches. */
  checkCredential(token: string, scope: { accountId: string | null }): Promise<CredentialReport>
  createTunnel(
    token: string,
    input: { accountId: string | null; name: string }
  ): Promise<TunnelCreated>
  fetchRunToken(
    token: string,
    input: { accountId: string | null; externalId: string }
  ): Promise<string>
  /** Issue a fresh run token for a tunnel without recreating it. */
  rotateRunToken(
    token: string,
    input: { accountId: string | null; externalId: string }
  ): Promise<string>
  /** Replace the full set of routes: every name goes to the local web server. */
  setRoutes(
    token: string,
    input: { accountId: string | null; externalId: string; hostnames: readonly string[] }
  ): Promise<void>
  /** Create the public DNS name for a hostname, pointing at the tunnel. */
  /**
   * Find the zone for a hostname among the zones of the tunnel's own account
   * that this token can reach. A tunnel can only route names whose zone is in
   * the same account, so no other account is searched. Throws `zone_not_found`
   * when none matches.
   */
  findZone(
    token: string,
    input: { accountId: string | null; hostname: string }
  ): Promise<ProviderZone>
  createDnsName(
    token: string,
    input: { zoneId: string; hostname: string; externalId: string }
  ): Promise<{ recordId: string }>
  removeDnsName(token: string, input: { zoneId: string; recordId: string }): Promise<void>
  deleteTunnel(
    token: string,
    input: { accountId: string | null; externalId: string }
  ): Promise<void>
}
