import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  ENVELOPE_MAGIC,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type { ManagedApplyCommandPayload } from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { CommandType } from '../../lib/commands/types.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { composeDocumentToYaml } from '../../lib/compose/convert.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import type { ManagedEngineSpec } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import { managed, principal } from '../../lib/db/schema.ts'
import type { Db } from '../../db.ts'
import { resolveHostingBindAddress } from '../environments/deploy-prepare.ts'
import { listManagedPrincipals } from '../principals/store.ts'
import { ensureManagedContainerAllocation } from './allocate-managed-container.ts'

const AT_REST_ENVELOPE_PREFIX = `${ENVELOPE_MAGIC}.`
const APPLY_EXPIRES_MS = 600_000

export type ManagedApplyPrepareError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'managed_credential_not_sealed' }
  | { kind: 'managed_settings_invalid' }

export type BuildManagedApplyInput = {
  managedRow: {
    id: string
    metadata?: unknown
    engine?: string | null
  }
  spec: ManagedEngineSpec
  settings: ManagedSettings
  databases: string[]
  serverId: string
  environmentId: string
  /** Ignored when present — always taken from `spec.rootUsername`. */
  rootUsername?: string
  dropUsers?: string[]
  dropDatabases?: string[]
  /** Principals to omit from credentials (e.g. about-to-be-deleted users). */
  omitPrincipalIds?: string[]
}

/**
 * Verify daemon-key + bind resolution before generating show-once passwords or
 * committing irreversible managed mutations. Does not require principals to exist.
 */
export async function preflightManagedApplyInfrastructure(
  c: Context<AppEnv>,
  db: Db,
  params: {
    serverId: string
    bind: ManagedSettings['exposure']['bind']
  },
): Promise<ManagedApplyPrepareError | null> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: params.serverId }
  }

  const daemonState = await getServerDaemonStateByServerId(db, params.serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId: params.serverId }
  }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId: params.serverId,
    options: { bind: params.bind },
    ipId: null,
  })
  if (typeof bindResolved === 'object' && bindResolved?.kind === 'datacenter_ip_required') {
    return bindResolved
  }

  return null
}

export function isPrepareError(
  value: ManagedApplyCommandPayload | ManagedApplyPrepareError,
): value is ManagedApplyPrepareError {
  return 'kind' in value
}

export function prepareErrorResponse(
  c: Context<AppEnv>,
  error: ManagedApplyPrepareError,
): Response {
  switch (error.kind) {
    case 'datacenter_ip_required':
      return c.json({ error: 'datacenter_ip_required' }, 422)
    case 'daemon_key_unavailable':
      return c.json({ error: 'daemon_key_unavailable' }, 422)
    case 'managed_credential_not_sealed':
      return c.json({ error: 'managed_credential_not_sealed' }, 500)
    case 'managed_settings_invalid':
      return c.json({ error: 'managed_settings_invalid' }, 400)
  }
}

export function mapManagedApplyPrepareError(
  c: Context<AppEnv>,
  error: ManagedApplyPrepareError,
): Response {
  return prepareErrorResponse(c, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManagedRootPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedRoot === true
}

function principalDatabases(metadata: unknown): string[] {
  if (!isRecord(metadata)) return []
  if (!Array.isArray(metadata.databases)) return []
  return metadata.databases.filter((entry): entry is string => typeof entry === 'string')
}

function principalPrivileges(metadata: unknown): string[] | undefined {
  if (!isRecord(metadata)) return undefined
  if (!Array.isArray(metadata.privileges)) return undefined
  const privileges = metadata.privileges.filter(
    (entry): entry is string => typeof entry === 'string',
  )
  return privileges.length > 0 ? privileges : undefined
}

function composeFromRuntimeSpec(
  spec: ManagedEngineSpec,
  settings: ManagedSettings,
  managedId: string,
): { composeYaml: string; runtime: ReturnType<ManagedEngineSpec['buildRuntimeSpec']> } {
  const runtime = spec.buildRuntimeSpec({
    managedId,
    settings,
    rootUsername: spec.rootUsername,
  })

  const volumes: Record<string, Record<string, never>> = {}
  for (const volume of runtime.volumes) {
    volumes[volume.name] = {}
  }

  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        [runtime.composeServiceName]: runtime.service,
      },
      ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    },
    presentation: {
      keyOrder: ['services', ...(Object.keys(volumes).length > 0 ? ['volumes'] : [])],
      comments: {},
    },
  }

  return { composeYaml: composeDocumentToYaml(document), runtime }
}

async function buildCredentials(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  managedId: string,
  serverId: string,
  omitPrincipalIds?: string[],
): Promise<ManagedApplyCommandPayload['credentials'] | ManagedApplyPrepareError> {
  const omit = new Set(omitPrincipalIds ?? [])
  const rows = (await listManagedPrincipals(db, managedId))
    .filter((row) => !omit.has(row.id))
  if (rows.length === 0) {
    return { kind: 'managed_credential_not_sealed' }
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const credentials: ManagedApplyCommandPayload['credentials'] = []
  for (const row of rows) {
    const [passwordRow] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, row.id))
      .limit(1)
    const sealed = passwordRow?.password
    if (typeof sealed !== 'string' || !sealed.startsWith(AT_REST_ENVELOPE_PREFIX)) {
      return { kind: 'managed_credential_not_sealed' }
    }

    const resealed = await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      { serverId, keyId: daemonState.key.id },
      sealed,
    )

    const role = isManagedRootPrincipal(row.metadata) ? 'root' : 'user'
    const credential: ManagedApplyCommandPayload['credentials'][number] = {
      principalId: row.id,
      username: row.username,
      role,
      databases: principalDatabases(row.metadata),
      password: resealed,
    }
    const privileges = principalPrivileges(row.metadata)
    if (privileges !== undefined) credential.privileges = privileges
    credentials.push(credential)
  }

  return credentials
}

export async function buildManagedApplyPayload(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
): Promise<ManagedApplyCommandPayload | ManagedApplyPrepareError> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: input.serverId }
  }

  const { composeYaml, runtime } = composeFromRuntimeSpec(
    input.spec,
    input.settings,
    input.managedRow.id,
  )

  // Pre-allocate service + ordinal-1 container; name is always `<id>-1` so a
  // future read-replica fan-out can use `-2`, `-3`, … without renaming primary.
  // Throws on allocation failure — create-path `db.transaction` rolls back;
  // re-apply surfaces as 500 (no new ManagedApplyPrepareError kind).
  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: input.environmentId,
    serverId: input.serverId,
    composeServiceName: runtime.composeServiceName,
  })

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId: input.serverId,
    options: { bind: input.settings.exposure.bind },
    ipId: null,
  })
  if (typeof bindResolved === 'object' && bindResolved?.kind === 'datacenter_ip_required') {
    return bindResolved
  }

  const exposure: ManagedApplyCommandPayload['exposure'] = {
    enabled: input.settings.exposure.enabled,
    protocol: input.spec.exposeProtocol,
  }
  if (input.settings.exposure.publishedPort !== undefined) {
    exposure.publishedPort = input.settings.exposure.publishedPort
  }
  if (typeof bindResolved === 'string') {
    exposure.bindAddress = bindResolved
  }

  const credentials = await buildCredentials(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    input.managedRow.id,
    input.serverId,
    input.omitPrincipalIds,
  )
  if (!Array.isArray(credentials)) return credentials

  const databases: NonNullable<ManagedApplyCommandPayload['databases']> = [
    ...input.databases.map((name) => ({ name, action: 'create' as const })),
    ...(input.dropDatabases ?? []).map((name) => ({
      name,
      action: 'drop' as const,
    })),
  ]

  const payload: ManagedApplyCommandPayload = {
    managedId: input.managedRow.id,
    environmentId: input.environmentId,
    engine: input.spec.engine,
    projectName: `turbopanel-managed-${input.managedRow.id}`,
    containerName: allocation.containerName,
    image: input.settings.image ?? input.spec.defaultImage,
    containerPort: input.spec.defaultPort,
    composeYaml,
    configFiles: runtime.configFiles,
    volumes: runtime.volumes,
    exposure,
    credentials,
  }

  if (input.settings.resources) payload.resources = input.settings.resources
  if (input.settings.dockerOptions) payload.dockerOptions = input.settings.dockerOptions
  if (databases.length > 0) payload.databases = databases
  if (input.dropUsers && input.dropUsers.length > 0) {
    payload.dropUsers = input.dropUsers
  }
  if (runtime.tlsMaterial) payload.tlsMaterial = runtime.tlsMaterial

  return payload
}

/**
 * Shared enqueue-and-record path for every `managed.*` command. `setApplying`
 * flips `managed.status` to `'applying'` before enqueue (used by
 * `managed.apply` and `managed.restore` — both mutate the running engine —
 * but never by `managed.backup`, which is read-only and must not perturb a
 * healthy engine's status).
 */
export async function enqueueTypedCommand(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    type: CommandType
    payload: unknown
    expiresAtMs: number
    managedId?: string
    setApplying?: boolean
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  if (params.setApplying && params.managedId) {
    await db
      .update(managed)
      .set({ status: 'applying', updatedAt: new Date().toISOString() })
      .where(eq(managed.id, params.managedId))
  }

  const expiresAt = new Date(Date.now() + params.expiresAtMs).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    type: params.type,
    payload: params.payload,
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: params.type,
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    if (params.setApplying && params.managedId) {
      await db
        .update(managed)
        .set({ status: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(managed.id, params.managedId))
    }
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return {
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}

export async function enqueueManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    payload: ManagedApplyCommandPayload
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.apply',
    payload: params.payload,
    expiresAtMs: APPLY_EXPIRES_MS,
    managedId: params.managedId,
    setApplying: true,
  })
}

export async function enqueueManagedLifecycle(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    action: 'start' | 'stop' | 'restart'
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.lifecycle',
    payload: { managedId: params.managedId, action: params.action },
    expiresAtMs: 120_000,
  })
}

export async function enqueueManagedDestroy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    removeVolumes: boolean
    /**
     * Set by the API delete route (single-click delete). Marks the payload
     * so `applyManagedDestroySideEffect` deletes the `managed` row (cascading
     * to `principal.managed_id`) after the destroy succeeds. Left unset for
     * any future "destroy runtime only" action.
     */
    deleteAfterDestroy?: boolean
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  const payload: Record<string, unknown> = {
    managedId: params.managedId,
    removeVolumes: params.removeVolumes,
  }
  if (params.deleteAfterDestroy) {
    payload.deleteAfterDestroy = true
  }
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.destroy',
    payload,
    expiresAtMs: 600_000,
  })
}
