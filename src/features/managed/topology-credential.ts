/**
 * Organization-wide Orchestrator topology account (control-plane derived).
 *
 * Orchestrator holds exactly **one** topology credential per process
 * (`MySQLTopologyUser` / `MySQLTopologyPassword`) and one Orchestrator runs per
 * organization, so every MySQL and MariaDB member of every HA cluster in that
 * organization has to accept the same login. A cluster's replication user
 * cannot be that login: a server that hosts two HA clusters has two
 * replication users, and whichever one the payload named was refused by every
 * member of the other cluster (`Error 1045 Access denied for user`), so
 * nothing registered and automatic failover never started. Servers with more
 * than one HA cluster are the normal case, so picking a better cluster out of
 * the list is not a fix — the account has to be organization-wide.
 *
 * The credential is **derived, not stored**: HMAC-SHA256 over the organization
 * id under its own HKDF purpose off the root secret, the same keyring the
 * at-rest envelopes and the session signer derive from. Nothing is written, so
 * there is no table, no migration, and no mint path to race — an organization
 * that already has clusters picks the account up on its next `managed.apply`,
 * and `managed.ha.reconcile` derives the identical value for Orchestrator's
 * own config without reading anything back.
 *
 * Rotating the root secret changes the derived password (derivation always
 * uses the current version, never a rotation fallback). The next
 * `managed.apply` re-asserts the new password on every member and the next
 * `managed.ha.reconcile` rewrites Orchestrator's config, so a rotation costs
 * one apply + reconcile pair per organization rather than a migration.
 *
 * Postgres is never derived for and never delivered to: the bundled
 * Orchestrator speaks the MySQL protocol only (`orchestratorManagesEngine`).
 */

import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import {
  type DaemonSecretRecipient,
  encryptSecretForDaemon,
} from '../../lib/secrets/data-encryption.ts'
import { deriveKey, type SecretsConfig } from '../../lib/secrets/secrets.ts'

/**
 * HKDF `info` for the derivation key. Its own purpose string: the topology
 * password must not be reachable from the session signer or from the at-rest
 * encryption keyring.
 */
export const TOPOLOGY_CREDENTIAL_PURPOSE = 'managed-topology-credential'

/**
 * Derived password length. MySQL and MariaDB cap an account name at 32
 * characters and the same cap is kept for the password so one value is safe
 * everywhere it is replayed (member accounts, Orchestrator config).
 */
export const TOPOLOGY_PASSWORD_LENGTH = 32

export type OrganizationTopologyCredential = {
  username: string
  /** Derived plaintext. Never stored, never logged. */
  password: string
}

/**
 * Deterministic per-organization account name. The short id prefix keeps it
 * inside the 32-character engine account limit while staying unique across
 * organizations (`tp_topology_` + 12 hex characters of the organization UUID).
 */
export function topologyUsernameForOrganization(organizationId: string): string {
  return `tp_topology_${organizationId.replaceAll('-', '').slice(0, 12)}`
}

/**
 * Derive the organization's topology credential. The same organization under
 * the same root secret always yields the same username and password, on any
 * isolate and in either runtime — which is what lets the member accounts and
 * Orchestrator's config be written by two different code paths with nothing
 * stored in between.
 */
export async function deriveOrganizationTopologyCredential(
  secretsConfig: SecretsConfig,
  organizationId: string
): Promise<OrganizationTopologyCredential> {
  const current = secretsConfig.versioned[0]
  if (!current) {
    throw new Error('No signing secret available — configure TURBOPANEL_SECRET')
  }
  const key = await deriveKey(current.value, TOPOLOGY_CREDENTIAL_PURPOSE)
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`organization:${organizationId}`)
  )
  return {
    username: topologyUsernameForOrganization(organizationId),
    // base64url alphabet only — no quote, backslash, or control character for
    // the engines' literal quoting to have to escape.
    password: base64urlEncode(new Uint8Array(mac)).slice(0, TOPOLOGY_PASSWORD_LENGTH),
  }
}

/**
 * The payload field both `managed.apply` and `managed.ha.reconcile` carry:
 * username plus the derived password sealed to one daemon (`tpdaemon`). The
 * plaintext is derived on the spot and sealed immediately — unlike the other
 * managed credentials there is no at-rest envelope to reseal from.
 */
export async function buildOrganizationTopologyUser(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  organizationId: string
): Promise<{ username: string; password: string }> {
  const derived = await deriveOrganizationTopologyCredential(secretsConfig, organizationId)
  return {
    username: derived.username,
    password: await encryptSecretForDaemon(secretsConfig, recipient, derived.password),
  }
}
