import type { BadgeCapabilities, TokenInfo, TunnelProvider } from './vocabulary.ts'

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
  /** What the provider says about the token itself: owner kind, id, status, expiry. */
  token: TokenInfo
}

/** What a pasted token reaches before the person has chosen an account. */
export type TokenDiscovery = { accounts: ProviderAccount[]; token: TokenInfo }

export type TunnelCreated = { externalId: string; runToken: string }

/** A certificate the provider issued from a request, for the hop between its edge and the origin. */
export type OriginCertificateIssued = {
  externalId: string
  certificatePem: string
  /** ISO time the provider says the certificate stops being valid. */
  notAfter: string
}

/**
 * One adapter per tunnel provider. Every method takes the credential as an
 * argument and never keeps it; errors are `TunnelProviderError`, already
 * scrubbed. Adding a provider means a new adapter and a new member in the
 * provider list, with no change to the tables.
 */
export type TunnelAdapter = {
  readonly provider: TunnelProvider
  /** A plain-words reason a pasted value cannot be an API token, or null. */
  tokenShapeProblem(token: string): string | null
  /** List the accounts a token can reach, for the person to pick from. */
  discoverAccounts(token: string): Promise<TokenDiscovery>
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
    input: {
      accountId: string | null
      externalId: string
      hostnames: readonly string[]
      /**
       * Verify the hop to the local web server instead of skipping verification.
       * The connector already trusts the provider's own origin roots, so this
       * only helps names served with a provider origin certificate (or a public
       * one). Left out, verification stays off.
       */
      verifyOrigin?: boolean
    }
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
  /**
   * Origin certificates, for providers that issue them. The caller makes the key
   * and sends only the request, so the private key never reaches the provider.
   */
  issueOriginCertificate?(
    token: string,
    input: { hostnames: readonly string[]; csrPem: string; validityDays: number }
  ): Promise<OriginCertificateIssued>
  /** Revoke a certificate issued by `issueOriginCertificate`. */
  revokeOriginCertificate?(token: string, input: { externalId: string }): Promise<void>
}
