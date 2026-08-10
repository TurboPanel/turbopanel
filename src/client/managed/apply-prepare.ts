import { and, eq, ne } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  decryptSecret,
  encryptSecret,
  ENVELOPE_MAGIC,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import type {
  ManagedApplyCommandPayload,
  ManagedApplyOrgTlsMaterial,
} from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { CommandType } from '../../lib/commands/types.ts'
import { TERMINAL_COMMAND_STATUSES } from '../../lib/commands/types.ts'
import {
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import { composeDocumentToYaml } from '../../lib/compose/convert.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import type { ManagedEngineSpec, BuildRuntimeSpecInput } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'
import {
  isPrivateEndpointError,
  privateEndpointErrorResponse,
  type PrivateEndpointError,
} from '../../lib/net/private-endpoint.ts'
import { managed, principal, server as serverTable, tls } from '../../lib/db/schema.ts'
import {
  issueLeafCertificate,
  metadataFromParsed,
  mintOrganizationCa,
  splitTlsMetadata,
} from '../../lib/tls/index.ts'
import type { Db } from '../../db.ts'
import { resolveHostingBindAddress } from '../environments/deploy-prepare.ts'
import { listManagedPrincipals, ensureManagedReplicationPrincipal } from '../principals/store.ts'
import { isOrganizationCaUniqueViolation } from '../tls/routes-helpers.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import {
  ensureManagedContainerAllocation,
  pruneLegacyManagedIngressContainers,
} from './allocate-managed-container.ts'
import {
  enqueueManagedIngressReconcile,
} from './ingress-desired.ts'
import {
  ensureManagedPrimaryMember,
  ensureMemberPrivatePorts,
  isManagedPrivatePortExhaustedError,
  listManagedMembers,
  type ManagedMemberPeer,
  type ManagedMemberRow,
  resolvePeersForMember,
  updateMemberReplicationTransport,
} from './members.ts'
import { parseManagedResidual } from './serialize.ts'

const AT_REST_ENVELOPE_PREFIX = `${ENVELOPE_MAGIC}.`
const APPLY_EXPIRES_MS = 600_000
/** Polling cadence while awaiting primary apply before standby enqueue. */
const COMMAND_AWAIT_POLL_MS = 1_000

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until a command row is terminal or the timeout elapses.
 * Used so primary replication setup completes before standby basebackup.
 */
export async function awaitCommandTerminal(
  db: Db,
  commandId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<CommandRecord | null> {
  const timeoutMs = options?.timeoutMs ?? APPLY_EXPIRES_MS
  const pollMs = options?.pollMs ?? COMMAND_AWAIT_POLL_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = await getCommandRecord(db, commandId)
    if (record && TERMINAL_COMMAND_STATUSES.has(record.status)) {
      return record
    }
    await sleepMs(pollMs)
  }
  return await getCommandRecord(db, commandId)
}

function isPrimaryMemberPayload(
  member: PreparedManagedMemberApply,
): boolean {
  if (member.payload.memberRole === 'primary') return true
  if (member.payload.replication?.role === 'primary') return true
  // Single-member / payloads without replication treat as primary.
  if (!member.payload.replication) return true
  return false
}

async function enqueueOneManagedApplyMember(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    member: PreparedManagedMemberApply
    extraMetadata?: Record<string, unknown>
  },
): Promise<ManagedApplyEnqueueResult> {
  const { member } = params
  const expiresAt = new Date(Date.now() + APPLY_EXPIRES_MS).toISOString()
  try {
    const record = await createCommandRecord(db, {
      serverId: member.serverId,
      actorType: 'user',
      actorId: params.userId,
      type: 'managed.apply',
      payload: member.payload,
      expiresAt,
      ...(params.extraMetadata
        ? { metadata: params.extraMetadata }
        : {}),
    })
    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: member.serverId,
      type: 'managed.apply',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    try {
      await commandQueue.enqueue(envelope)
      return {
        memberId: member.memberId,
        serverId: member.serverId,
        commandId: record.id,
        status: 'queued',
      }
    } catch {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: 'Command queue unavailable',
      })
      return {
        memberId: member.memberId,
        serverId: member.serverId,
        status: 'failed',
        error: 'Command queue unavailable',
      }
    }
  } catch (err) {
    return {
      memberId: member.memberId,
      serverId: member.serverId,
      status: 'failed',
      error: err instanceof Error ? err.message : 'enqueue failed',
    }
  }
}

export type ManagedApplyPrepareError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'managed_credential_not_sealed' }
  | { kind: 'managed_settings_invalid' }
  | { kind: 'managed_primary_missing' }
  | { kind: 'managed_private_port_exhausted'; serverId: string }
  | PrivateEndpointError

export type BuildManagedApplyInput = {
  managedRow: {
    id: string
    metadata?: unknown
    engine?: string | null
    serverId?: string | null
  }
  spec: ManagedEngineSpec
  settings: ManagedSettings
  databases: string[]
  /** Primary pin — used by ensureManagedPrimaryMember self-heal. */
  serverId: string
  environmentId: string
  /** Org that owns the managed service (and the org CA library). */
  organizationId: string
  /** Cluster root login when persisted; else `spec.rootUsername` preference. */
  rootUsername?: string
  dropUsers?: string[]
  dropDatabases?: string[]
  /** Principals to omit from credentials (e.g. about-to-be-deleted users). */
  omitPrincipalIds?: string[]
  /**
   * Members to omit from this prepare (e.g. a replica being destroyed).
   * Shrinks primary `desiredSlots` / peers before the row is deleted.
   */
  excludeMemberIds?: string[]
}

export type PreparedManagedMemberApply = {
  memberId: string
  serverId: string
  payload: ManagedApplyCommandPayload
}

export type ManagedApplyEnqueueResult = {
  memberId: string
  serverId: string
  commandId?: string
  status: 'queued' | 'failed'
  error?: string
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
  value: unknown,
): value is ManagedApplyPrepareError {
  return typeof value === 'object' && value !== null && 'kind' in value
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
    case 'managed_primary_missing':
      return c.json({ error: 'managed_primary_missing' }, 500)
    case 'managed_private_port_exhausted':
      return c.json({ error: 'managed_private_port_exhausted' }, 409)
    case 'peer_tunnel_address_required':
    case 'private_path_unavailable':
      return privateEndpointErrorResponse(c, error)
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

function isManagedReplicationPrincipal(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return metadata.managedReplication === true
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
  rootUsername: string,
  member?: BuildRuntimeSpecInput['member'],
  useOrgTls?: boolean,
): { composeYaml: string; runtime: ReturnType<ManagedEngineSpec['buildRuntimeSpec']> } {
  const runtime = spec.buildRuntimeSpec({
    managedId,
    settings,
    rootUsername,
    ...(member !== undefined ? { member } : {}),
    ...(useOrgTls === true ? { useOrgTls: true } : {}),
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
    // Replication principals are attached separately when multi-member.
    if (isManagedReplicationPrincipal(row.metadata)) continue

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

type ActiveOrganizationCa = {
  certificatePem: string
  privateKeyPemSealed: string
}

/**
 * Look up the active org CA, or mint + insert one when absent (same ensure
 * semantics as `GET /tls/ca`). Returns sealed CA private key for leaf issue.
 */
export async function ensureActiveOrganizationCa(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  organizationId: string,
): Promise<ActiveOrganizationCa | ManagedApplyPrepareError> {
  const [existing] = await db
    .select({
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
    })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
        ne(tls.status, 'revoked'),
      ),
    )
    .limit(1)

  if (existing) {
    if (
      typeof existing.certificatePem !== 'string' ||
      existing.certificatePem.length === 0 ||
      typeof existing.privateKeyPem !== 'string' ||
      !existing.privateKeyPem.startsWith(AT_REST_ENVELOPE_PREFIX)
    ) {
      return { kind: 'managed_credential_not_sealed' }
    }
    return {
      certificatePem: existing.certificatePem,
      privateKeyPemSealed: existing.privateKeyPem,
    }
  }

  const material = await mintOrganizationCa()
  const privateKeyPemSealed = await encryptSecret(
    dataEncryptionSecrets,
    material.privateKeyPem,
  )
  if (!privateKeyPemSealed.startsWith(AT_REST_ENVELOPE_PREFIX)) {
    return { kind: 'managed_credential_not_sealed' }
  }
  const { columns, residual } = splitTlsMetadata(
    metadataFromParsed(material.parsed, 'ready'),
  )

  try {
    await db.transaction(async (tx) => {
      const [race] = await tx
        .select({ id: tls.id })
        .from(tls)
        .where(
          and(
            eq(tls.organizationId, organizationId),
            eq(tls.source, 'organization_ca'),
            ne(tls.status, 'revoked'),
          ),
        )
        .limit(1)
      if (race) return

      await tx.insert(tls).values({
        organizationId,
        name: 'Organization CA',
        source: 'organization_ca',
        certificatePem: material.certificatePem,
        privateKeyPem: privateKeyPemSealed,
        status: columns.status,
        notAfter: columns.notAfter,
        fingerprintSha256: columns.fingerprintSha256,
        metadata: residual,
        options: null,
      })
    })
  } catch (err) {
    if (!isOrganizationCaUniqueViolation(err)) throw err
  }

  const [row] = await db
    .select({
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
    })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
        ne(tls.status, 'revoked'),
      ),
    )
    .limit(1)

  if (
    !row ||
    typeof row.certificatePem !== 'string' ||
    row.certificatePem.length === 0 ||
    typeof row.privateKeyPem !== 'string' ||
    !row.privateKeyPem.startsWith(AT_REST_ENVELOPE_PREFIX)
  ) {
    return { kind: 'managed_credential_not_sealed' }
  }
  return {
    certificatePem: row.certificatePem,
    privateKeyPemSealed: row.privateKeyPem,
  }
}

/**
 * Issue a managed leaf from an org CA and reseal the leaf private key as a
 * daemon-bound `denc` envelope for `payload.orgTlsMaterial`.
 *
 * Exported for host-free unit tests (no DB).
 *
 * `ipAddresses` become iPAddress SANs so remote MySQL/MariaDB (and similar)
 * clients dialling the private listener IP with verify-identity can match.
 */
export async function buildManagedOrgTlsMaterial(
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  recipient: { serverId: string; keyId: string },
  ca: { certificatePem: string; privateKeyPem: string },
  managedId: string,
  extraSans: readonly string[] = [],
  ipAddresses: readonly string[] = [],
): Promise<ManagedApplyOrgTlsMaterial> {
  const leafName = `managed-${managedId}`
  const sans = [
    leafName,
    'localhost',
    ...extraSans.filter((s) => s.length > 0 && s !== leafName && s !== 'localhost'),
  ]
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    sans,
    {
      commonName: leafName,
      ...(ipAddresses.length > 0 ? { ipAddresses: [...ipAddresses] } : {}),
    },
  )
  const sealedLeafKey = await encryptSecret(
    dataEncryptionSecrets,
    leaf.privateKeyPem,
  )
  const privateKeyEnvelope = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    recipient,
    sealedLeafKey,
  )
  return {
    certificatePem: leaf.certificatePem,
    privateKeyEnvelope,
    caCertPem: ca.certificatePem,
  }
}

async function buildOrgTlsMaterialForServer(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    organizationId: string
    serverId: string
    managedId: string
    extraSans?: readonly string[]
    ipAddresses?: readonly string[]
  },
): Promise<ManagedApplyOrgTlsMaterial | ManagedApplyPrepareError> {
  const { organizationId, serverId, managedId, extraSans = [], ipAddresses = [] } = params
  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }

  const ca = await ensureActiveOrganizationCa(
    db,
    dataEncryptionSecrets,
    organizationId,
  )
  if ('kind' in ca) return ca

  const caPrivateKeyPem = await decryptSecret(
    dataEncryptionSecrets,
    ca.privateKeyPemSealed,
  )
  return buildManagedOrgTlsMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    { certificatePem: ca.certificatePem, privateKeyPem: caPrivateKeyPem },
    managedId,
    extraSans,
    ipAddresses,
  )
}

function resolveRootUsername(
  input: BuildManagedApplyInput,
): string {
  const residual = parseManagedResidual(input.managedRow.metadata)
  return residual.rootUsername ?? input.rootUsername ?? input.spec.rootUsername
}

/**
 * Resolve this member's private-listener address (when it has a private
 * port) and its `BuildRuntimeSpecInput['member']` replication shape (primary
 * desired-slots / peer addresses, or standby slot + upstream primary).
 * Returns `undefined` for single-member clusters (no replication username).
 */
async function resolveMemberReplicationInput(
  db: Db,
  managedId: string,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    roleForSpec: 'primary' | 'standby'
    replicationUsername: string | null
    multiMember: boolean
    peers: ManagedMemberPeer[]
  },
): Promise<BuildRuntimeSpecInput['member'] | undefined | ManagedApplyPrepareError> {
  const { members, member, roleForSpec, replicationUsername, multiMember, peers } = params
  if (!multiMember || !replicationUsername) return undefined

  let privateListener: { address: string; port: number } | undefined
  if (member.privatePort !== null) {
    const privateBind = await resolveHostingBindAddress(db, {
      serverId: member.serverId,
      options: { bind: 'datacenter' },
      ipId: null,
    })
    if (typeof privateBind === 'string' && privateBind.length > 0) {
      privateListener = { address: privateBind, port: member.privatePort }
    } else if (members.some((m) => m.serverId !== member.serverId)) {
      // Multi-host cluster without a resolvable private address.
      const remote = members.find((m) => m.serverId !== member.serverId)!
      return {
        kind: 'private_path_unavailable',
        fromServerId: member.serverId,
        toServerId: remote.serverId,
      }
    }
    // All co-resident: no private listener publish needed.
  }

  if (roleForSpec === 'primary') {
    const desiredSlots = members
      .filter((m) => m.role === 'replica')
      .map((m) => `tp_member_${m.ordinal}`)
    return {
      role: 'primary',
      ordinal: member.ordinal,
      replication: {
        username: replicationUsername,
        desiredSlots,
        peerAddresses: peers.map((p) => p.address),
      },
      ...(privateListener !== undefined ? { privateListener } : {}),
    }
  }

  const primaryPeer = peers.find((p) => p.role === 'primary')
  if (!primaryPeer) {
    return { kind: 'managed_primary_missing' }
  }
  const host = primaryPeer.containerName ?? `managed-${managedId}`
  return {
    role: 'standby',
    ordinal: member.ordinal,
    replication: {
      username: replicationUsername,
      slotName: `tp_member_${member.ordinal}`,
      primary: {
        host,
        ...(primaryPeer.containerName ? {} : { hostaddr: primaryPeer.address }),
        port: primaryPeer.port,
      },
    },
    ...(privateListener !== undefined ? { privateListener } : {}),
  }
}

/**
 * Attach the cluster's replication principal credential, when one exists.
 * No-op for single-member clusters (no replication username).
 */
async function attachReplicationCredential(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    managedId: string
    serverId: string
    multiMember: boolean
    replicationUsername: string | null
    credentials: ManagedApplyCommandPayload['credentials']
  },
): Promise<ManagedApplyPrepareError | null> {
  const { managedId, serverId, multiMember, replicationUsername, credentials } = params
  if (!multiMember || !replicationUsername) return null

  const rows = await listManagedPrincipals(db, managedId)
  const repl = rows.find((row) => isManagedReplicationPrincipal(row.metadata))
  if (!repl) return null

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { kind: 'daemon_key_unavailable', serverId }
  }
  const [passwordRow] = await db
    .select({ password: principal.password })
    .from(principal)
    .where(eq(principal.id, repl.id))
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
  credentials.push({
    principalId: repl.id,
    username: repl.username,
    role: 'replication',
    databases: [],
    password: resealed,
  })
  return null
}

/** Build the payload `replication` field from a resolved member input, if any. */
function buildReplicationPayloadField(
  memberInput: BuildRuntimeSpecInput['member'] | undefined,
): ManagedApplyCommandPayload['replication'] | undefined {
  if (!memberInput?.replication) return undefined
  return {
    role: memberInput.role,
    username: memberInput.replication.username,
    ...(memberInput.replication.slotName !== undefined
      ? { slotName: memberInput.replication.slotName }
      : {}),
    ...(memberInput.replication.desiredSlots !== undefined
      ? { desiredSlots: memberInput.replication.desiredSlots }
      : {}),
    ...(memberInput.replication.peerAddresses !== undefined
      ? { peerAddresses: memberInput.replication.peerAddresses }
      : {}),
    ...(memberInput.replication.primary !== undefined
      ? { primary: memberInput.replication.primary }
      : {}),
  }
}

/** Attach the optional replication/resource/database/TLS payload fields. */
function attachOptionalPayloadFields(
  payload: ManagedApplyCommandPayload,
  input: BuildManagedApplyInput,
  memberInput: BuildRuntimeSpecInput['member'] | undefined,
  runtime: ReturnType<ManagedEngineSpec['buildRuntimeSpec']>,
  databases: NonNullable<ManagedApplyCommandPayload['databases']>,
): void {
  if (memberInput?.privateListener) {
    payload.privateListener = memberInput.privateListener
  }
  const replication = buildReplicationPayloadField(memberInput)
  if (replication) payload.replication = replication

  if (input.settings.resources) payload.resources = input.settings.resources
  if (input.settings.dockerOptions) payload.dockerOptions = input.settings.dockerOptions
  if (databases.length > 0) payload.databases = databases
  if (input.dropUsers && input.dropUsers.length > 0) {
    payload.dropUsers = input.dropUsers
  }
  if (runtime.tlsMaterial) payload.tlsMaterial = runtime.tlsMaterial
}

/**
 * Resolve this member's org organization, ensure the ingress hierarchy, and
 * mint + attach its org-CA leaf material onto `payload`.
 */
async function attachManagedOrgTlsMaterial(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    input: BuildManagedApplyInput
    member: ManagedMemberRow
    memberInput: BuildRuntimeSpecInput['member'] | undefined
    containerSans: readonly string[]
    containerName: string
    payload: ManagedApplyCommandPayload
  },
): Promise<ManagedApplyPrepareError | null> {
  const { input, member, memberInput, containerSans, containerName, payload } = params
  const [memberServer] = await db
    .select({ organizationId: serverTable.organizationId })
    .from(serverTable)
    .where(eq(serverTable.id, member.serverId))
    .limit(1)
  const memberOrganizationId =
    memberServer?.organizationId ?? input.organizationId

  await ensureManagedIngressHierarchy(db, {
    organizationId: memberOrganizationId,
    serverId: member.serverId,
  })

  const orgTlsMaterial = await buildOrgTlsMaterialForServer(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    {
      organizationId: memberOrganizationId,
      serverId: member.serverId,
      managedId: input.managedRow.id,
      extraSans: [...containerSans, containerName],
      // Private listener IP must be an IP SAN so remote MySQL/MariaDB replicas
      // using hostaddr + VERIFY_IDENTITY match the primary leaf.
      ipAddresses: memberInput?.privateListener ? [memberInput.privateListener.address] : [],
    },
  )
  if ('kind' in orgTlsMaterial) return orgTlsMaterial
  payload.orgTlsMaterial = orgTlsMaterial
  return null
}

async function buildPayloadForMember(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    multiMember: boolean
    replicationUsername: string | null
    containerSans: readonly string[]
  },
): Promise<ManagedApplyCommandPayload | ManagedApplyPrepareError> {
  const { members, member, multiMember, replicationUsername, containerSans } = params
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: member.serverId }
  }

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId: member.serverId,
    bind: input.settings.exposure.bind,
  })
  if (infra) return infra

  const roleForSpec: 'primary' | 'standby' =
    member.role === 'replica' ? 'standby' : 'primary'

  // Resolve peer endpoints early — needed for replication + private listener.
  const peers = await resolvePeersForMember(
    db,
    members,
    member,
    input.spec.defaultPort,
  )
  if (isPrivateEndpointError(peers)) return peers

  const resolvedMemberInput = await resolveMemberReplicationInput(db, input.managedRow.id, {
    members,
    member,
    roleForSpec,
    replicationUsername,
    multiMember,
    peers,
  })
  if (isPrepareError(resolvedMemberInput)) return resolvedMemberInput
  const memberInput = resolvedMemberInput

  const rootUsername = resolveRootUsername(input)
  const { composeYaml, runtime } = composeFromRuntimeSpec(
    input.spec,
    input.settings,
    input.managedRow.id,
    rootUsername,
    memberInput,
    multiMember,
  )

  const memberOrdinals = members.map((m) => m.ordinal)
  const allocation = await ensureManagedContainerAllocation(db, {
    environmentId: input.environmentId,
    serverId: member.serverId,
    composeServiceName: runtime.composeServiceName,
    ordinal: member.ordinal,
    memberOrdinals,
  })

  await pruneLegacyManagedIngressContainers(db, allocation.serviceId)

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId: member.serverId,
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
  if (typeof bindResolved === 'string') {
    exposure.bindAddress = bindResolved
  }

  const credentials = await buildCredentials(
    db,
    secretsConfig,
    dataEncryptionSecrets,
    input.managedRow.id,
    member.serverId,
    input.omitPrincipalIds,
  )
  if (!Array.isArray(credentials)) return credentials

  const replError = await attachReplicationCredential(db, secretsConfig, dataEncryptionSecrets, {
    managedId: input.managedRow.id,
    serverId: member.serverId,
    multiMember,
    replicationUsername,
    credentials,
  })
  if (replError) return replError

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
    memberId: member.id,
    memberRole: member.role === 'replica' ? 'replica' : 'primary',
    memberOrdinal: member.ordinal,
    readEligible: member.readEligible,
    peers: peers.map((p) => ({
      memberId: p.memberId,
      role: p.role,
      readEligible: p.readEligible,
      address: p.address,
      transport: p.transport,
      port: p.port,
      ...(p.containerName !== undefined
        ? { containerName: p.containerName }
        : {}),
    })),
    credentials,
  }

  attachOptionalPayloadFields(payload, input, memberInput, runtime, databases)

  const tlsError = await attachManagedOrgTlsMaterial(db, secretsConfig, dataEncryptionSecrets, {
    input,
    member,
    memberInput,
    containerSans,
    containerName: allocation.containerName,
    payload,
  })
  if (tlsError) return tlsError

  return payload
}

/**
 * Prepare one `managed.apply` payload per cluster member (ordered by ordinal).
 * Self-heals primary membership and allocates containers per member ordinal.
 */
export async function prepareManagedApplyPayloads(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
): Promise<{ members: PreparedManagedMemberApply[] } | ManagedApplyPrepareError> {
  await ensureManagedPrimaryMember(db, {
    managedId: input.managedRow.id,
    serverId: input.serverId,
  })

  let members = await listManagedMembers(db, input.managedRow.id)
  if (input.excludeMemberIds && input.excludeMemberIds.length > 0) {
    const exclude = new Set(input.excludeMemberIds)
    members = members.filter((m) => !exclude.has(m.id))
  }
  if (members.length === 0) {
    return { kind: 'managed_primary_missing' }
  }

  const ports = await ensureMemberPrivatePorts(db, members)
  if (isManagedPrivatePortExhaustedError(ports)) {
    return ports
  }
  members = ports

  const multiMember = members.length > 1
  let replicationUsername: string | null = null
  if (multiMember) {
    const usernameOrError = await ensureClusterReplicationUsername(c, db, input)
    if (isPrepareError(usernameOrError)) return usernameOrError
    replicationUsername = usernameOrError
  }

  const containerSans = [`managed-${input.managedRow.id}`]

  const prepared: PreparedManagedMemberApply[] = []
  for (const member of members) {
    const result = await prepareOneMemberApply(c, db, input, {
      members,
      member,
      multiMember,
      replicationUsername,
      containerSans,
    })
    if (isPrepareError(result)) return result
    prepared.push(result)
  }

  return { members: prepared }
}

/** Mint (or reuse) the cluster's replication principal and persist its username. */
async function ensureClusterReplicationUsername(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
): Promise<string | ManagedApplyPrepareError> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!c.get('secretsConfig') || !dataEncryptionSecrets) {
    return { kind: 'daemon_key_unavailable', serverId: input.serverId }
  }

  const repl = await ensureManagedReplicationPrincipal(db, dataEncryptionSecrets, {
    managedId: input.managedRow.id,
    preferredUsername: 'tp_repl',
    provider: input.spec.principalProvider,
    identifier: input.spec.userOperations.identifier,
  })

  const residual = parseManagedResidual(input.managedRow.metadata)
  await db
    .update(managed)
    .set({
      metadata: {
        ...residual,
        replicationUsername: repl.username,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(managed.id, input.managedRow.id))

  return repl.username
}

/** Build one member's apply payload and self-heal its replication transport. */
async function prepareOneMemberApply(
  c: Context<AppEnv>,
  db: Db,
  input: BuildManagedApplyInput,
  params: {
    members: ManagedMemberRow[]
    member: ManagedMemberRow
    multiMember: boolean
    replicationUsername: string | null
    containerSans: readonly string[]
  },
): Promise<PreparedManagedMemberApply | ManagedApplyPrepareError> {
  const { member } = params
  const payload = await buildPayloadForMember(c, db, input, params)
  if (isPrepareError(payload)) return payload

  if (member.role === 'replica' && payload.peers.length > 0) {
    const primaryPeer = payload.peers.find((p) => p.role === 'primary')
    if (primaryPeer) {
      await updateMemberReplicationTransport(db, member.id, primaryPeer.transport)
    }
  }

  return {
    memberId: member.id,
    serverId: member.serverId,
    payload,
  }
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
    metadata?: Record<string, unknown>
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
    ...(params.metadata ? { metadata: params.metadata } : {}),
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

/**
 * Fan-out: one `managed.apply` per member server.
 *
 * Multi-member clusters enqueue the primary immediately and return command ids
 * without waiting. Standby members are recorded in command metadata so the
 * command consumer enqueues them only after primary apply succeeds.
 * Flips `managed.status` to `applying` once before enqueue; sets `failed` only
 * if every member fails to enqueue.
 */
export async function enqueuePreparedManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    members: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  if (params.members.length === 0) {
    return []
  }

  await db
    .update(managed)
    .set({ status: 'applying', updatedAt: new Date().toISOString() })
    .where(eq(managed.id, params.managedId))

  const primaryMembers = params.members.filter(isPrimaryMemberPayload)
  const standbyMembers = params.members.filter((m) => !isPrimaryMemberPayload(m))

  // Single-phase when no standby depends on primary prep.
  if (standbyMembers.length === 0) {
    return enqueueSinglePhaseManagedApply(c, db, commandQueue, {
      userId: params.userId,
      managedId: params.managedId,
      members: params.members,
    })
  }

  return enqueueTwoPhaseManagedApply(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    primaryMembers,
    standbyMembers,
  })
}

/** No standby depends on primary prep — enqueue every member concurrently. */
async function enqueueSinglePhaseManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    members: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const results = await Promise.all(
    params.members.map((member) =>
      enqueueOneManagedApplyMember(db, commandQueue, {
        userId: params.userId,
        member,
      }),
    ),
  )
  return finalizePreparedManagedApplyResults(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    results,
  })
}

/**
 * At least one standby depends on primary prep — enqueue primaries only and
 * defer standbys to the command consumer via `pendingStandbyApplies` metadata.
 */
async function enqueueTwoPhaseManagedApply(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    primaryMembers: PreparedManagedMemberApply[]
    standbyMembers: PreparedManagedMemberApply[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const { primaryMembers, standbyMembers } = params
  const results: ManagedApplyEnqueueResult[] = []

  if (primaryMembers.length === 0) {
    for (const standby of standbyMembers) {
      results.push({
        memberId: standby.memberId,
        serverId: standby.serverId,
        status: 'failed',
        error: 'Primary apply missing from multi-member prepare',
      })
    }
    return finalizePreparedManagedApplyResults(c, db, commandQueue, {
      userId: params.userId,
      managedId: params.managedId,
      results,
    })
  }

  const pendingStandbyApplies = standbyMembers.map((member) => ({
    serverId: member.serverId,
    memberId: member.memberId,
    payload: member.payload,
  }))

  let queuedPrimary = false
  for (const member of primaryMembers) {
    const result = await enqueueOneManagedApplyMember(db, commandQueue, {
      userId: params.userId,
      member,
      // Attach only once on the first primary command.
      extraMetadata: queuedPrimary
        ? undefined
        : { pendingStandbyApplies },
    })
    results.push(result)
    if (result.status === 'queued') queuedPrimary = true
    if (result.status !== 'queued') {
      for (const standby of standbyMembers) {
        results.push({
          memberId: standby.memberId,
          serverId: standby.serverId,
          status: 'failed',
          error: 'Primary apply failed before standby enqueue',
        })
      }
      return finalizePreparedManagedApplyResults(c, db, commandQueue, {
        userId: params.userId,
        managedId: params.managedId,
        results,
      })
    }
  }

  // Standbys are pending until the primary command succeeds (consumer).
  for (const standby of standbyMembers) {
    results.push({
      memberId: standby.memberId,
      serverId: standby.serverId,
      status: 'queued',
    })
  }

  return finalizePreparedManagedApplyResults(c, db, commandQueue, {
    userId: params.userId,
    managedId: params.managedId,
    results,
  })
}

async function finalizePreparedManagedApplyResults(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    results: ManagedApplyEnqueueResult[]
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const allFailed = params.results.every((r) => r.status === 'failed')
  if (allFailed) {
    await db
      .update(managed)
      .set({ status: 'failed', updatedAt: new Date().toISOString() })
      .where(eq(managed.id, params.managedId))
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (secretsConfig && dataEncryptionSecrets) {
    const serverIds = new Set(
      params.results
        .filter((r) => r.status === 'queued')
        .map((r) => r.serverId),
    )
    for (const serverId of serverIds) {
      await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId,
        actorType: 'user',
        actorId: params.userId,
        secretsConfig,
        dataEncryptionSecrets,
      })
    }
  }

  return params.results
}

export async function enqueueManagedLifecycleFanout(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    action: 'start' | 'stop' | 'restart'
    members: ManagedMemberRow[]
    engine?: string
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const results = await Promise.all(
    params.members.map(async (member): Promise<ManagedApplyEnqueueResult> => {
      const enqueued = await enqueueTypedCommand(c, db, commandQueue, {
        userId: params.userId,
        serverId: member.serverId,
        type: 'managed.lifecycle',
        payload: {
          managedId: params.managedId,
          action: params.action,
          memberId: member.id,
          ...(params.engine !== undefined ? { engine: params.engine } : {}),
        },
        expiresAtMs: 120_000,
      })
      if (enqueued instanceof Response) {
        return {
          memberId: member.id,
          serverId: member.serverId,
          status: 'failed',
          error: 'Command queue unavailable',
        }
      }
      return {
        memberId: member.id,
        serverId: member.serverId,
        commandId: enqueued.commandId,
        status: 'queued',
      }
    }),
  )
  return results
}

export async function enqueueManagedDestroyFanout(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    managedId: string
    removeVolumes: boolean
    members: ManagedMemberRow[]
    /** When true, only the primary command carries `deleteAfterDestroy`. */
    deleteAfterDestroy?: boolean
  },
): Promise<ManagedApplyEnqueueResult[] | Response> {
  const results = await Promise.all(
    params.members.map(async (member): Promise<ManagedApplyEnqueueResult> => {
      const payload: Record<string, unknown> = {
        managedId: params.managedId,
        removeVolumes: params.removeVolumes,
        memberId: member.id,
      }
      if (params.deleteAfterDestroy && member.role === 'primary') {
        payload.deleteAfterDestroy = true
      }
      const enqueued = await enqueueTypedCommand(c, db, commandQueue, {
        userId: params.userId,
        serverId: member.serverId,
        type: 'managed.destroy',
        payload,
        expiresAtMs: 600_000,
      })
      if (enqueued instanceof Response) {
        return {
          memberId: member.id,
          serverId: member.serverId,
          status: 'failed',
          error: 'Command queue unavailable',
        }
      }
      return {
        memberId: member.id,
        serverId: member.serverId,
        commandId: enqueued.commandId,
        status: 'queued',
      }
    }),
  )
  return results
}

/** Compatibility wrappers used by paths that still target a single primary. */
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
    memberId?: string
    engine?: string
  },
): Promise<
  | { ok: true; commandId: string; status: 'queued'; serverId: string }
  | Response
> {
  const payload: Record<string, unknown> = {
    managedId: params.managedId,
    action: params.action,
  }
  if (params.memberId) payload.memberId = params.memberId
  if (params.engine !== undefined) payload.engine = params.engine
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.lifecycle',
    payload,
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
    deleteAfterDestroy?: boolean
    memberId?: string
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
  if (params.memberId) payload.memberId = params.memberId
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.destroy',
    payload,
    expiresAtMs: 600_000,
  })
}
