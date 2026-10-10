/**
 * Replication credential helpers for `managed.ha.reconcile` cluster payloads.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { ENVELOPE_PREFIX_SECRET, resealSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { getServerDaemonStateByServerId, isDaemonKeyActive } from '../servers/server-identity-db.ts'
import { environment, managed, principal, project, replica, workspace } from '../../db/schema.ts'
import { orchestratorManagesEngine } from './ha-policy.ts'
import { isManagedReplicationPrincipal } from './ingress-desired-pure.ts'
import type { ManagedEngineSpec } from './index.ts'

export type HaSecretsParams = {
  serverId: string
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

/** Union of org-wide SQL HA clusters and managed ids present on the target server. */
export function mergeOrchestratorManagedClusterIds(
  orchestratorIds: readonly string[],
  localManagedIds: readonly string[]
): string[] {
  return [...new Set([...orchestratorIds, ...localManagedIds])].toSorted((a, b) =>
    a.localeCompare(b)
  )
}

export function orchestratorManagedClusterIdsFromRows(
  rows: ReadonlyArray<{ managedId: string; engine: string }>
): string[] {
  const counts = new Map<string, { engine: string; count: number }>()
  for (const row of rows) {
    const current = counts.get(row.managedId)
    if (!current) {
      counts.set(row.managedId, { engine: row.engine, count: 1 })
      continue
    }
    current.count += 1
  }
  return [...counts.entries()]
    .filter(([, meta]) => meta.count >= 2 && orchestratorManagesEngine(meta.engine))
    .map(([managedId]) => managedId)
    .toSorted((a, b) => a.localeCompare(b))
}

export async function listOrchestratorManagedClusterIds(
  db: Db,
  organizationId: string
): Promise<string[]> {
  const rows = await db
    .select({ managedId: replica.managedId, engine: managed.engine })
    .from(replica)
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(workspace.organizationId, organizationId))
  return orchestratorManagedClusterIdsFromRows(rows)
}

async function resealReplicationPassword(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  managedId: string,
  serverId: string
): Promise<{ username: string; envelope: string } | null> {
  const principals = await db
    .select({
      id: principal.id,
      username: principal.appliedUsername,
      password: principal.password,
      metadata: principal.metadata,
    })
    .from(principal)
    .where(eq(principal.managedId, managedId))
  const repl = principals.find((row) => isManagedReplicationPrincipal(row.metadata))
  if (!repl || typeof repl.password !== 'string') return null
  if (!repl.password.startsWith(ENVELOPE_PREFIX_SECRET)) return null

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) return null
  const resealed = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    repl.password
  )
  return { username: repl.username, envelope: resealed }
}

export async function resolveReplicationCredentialForHa(
  db: Db,
  params: HaSecretsParams,
  managedId: string,
  _spec: ManagedEngineSpec
): Promise<{ username: string; envelope: string } | null> {
  const resealed = await resealReplicationPassword(
    db,
    params.secretsConfig,
    params.dataEncryptionSecrets,
    managedId,
    params.serverId
  )
  if (resealed) return resealed

  // Replication credentials are created on primary `managed.apply`
  // (`ensureManagedReplicationPrincipal`). Never mint a Postgres-only password
  // here — Orchestrator must not receive a credential the engine does not hold.
  return null
}
