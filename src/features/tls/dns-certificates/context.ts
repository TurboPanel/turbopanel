import type { Db } from '../../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import type { DnsChallengeProvider } from './dns-provider.ts'

/** Everything the leftover-record cleanup needs. Tests replace the DNS host and the clock. */
export type DnsCertContext = {
  db: Db
  /** Opens the provider token. */
  secrets: DerivedSecretsConfig
  /** The DNS host for one provider and token. */
  dns: (provider: TunnelProvider, token: string) => DnsChallengeProvider
  now?: () => Date
}

/** One cleanup pass may hold a certificate row this long before another worker may take it. */
export const CLAIM_MS = 90_000
