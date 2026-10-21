/**
 * Backup copy targets: named S3-compatible destinations an organization copies
 * finished backups to, where each applies (the organization default, with a
 * per-cluster override), and the wire form a host receives.
 *
 * The secret access key is sealed at rest (`tpsecret`) and re-sealed for one
 * host's daemon key when it is sent. No function here returns it to a caller
 * outside this module's sealing helpers.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  backupTarget,
  backupTargetAssignment,
  environment,
  managed,
  project,
  workspace,
} from '../../db/schema.ts'
import type { BackupCopyTargetWire } from '../../contracts/commands/schemas.ts'
import {
  decryptSecret,
  encryptSecret,
  resealSecretForDaemon,
} from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { BACKUP_S3_COPY_FEATURE } from '../../lib/version-wire.ts'
import { resolveManagedHomeOrganizationId } from '../principals/store.ts'
import { isDaemonKeyActive } from '../servers/daemon-state.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { endpointRefusal } from './endpoint-guard.ts'

export const MAX_BACKUP_TARGETS_PER_ORG = 20
export const MAX_TARGET_NAME_LENGTH = 64

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const PREFIX_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
const ACCESS_KEY_RE = /^[\x21-\x7e]{1,128}$/
const MAX_SECRET_KEY_LENGTH = 256

export type BackupTargetRow = typeof backupTarget.$inferSelect

/** A target as the API shows it. The secret key is never part of it. */
export function toApiTarget(row: BackupTargetRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    pathStyle: row.isPathStyle,
    serverSideEncryption: row.isServerSideEncrypted,
    accessKeyId: row.accessKeyId,
    hasSecret: true,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.isLastTestOk,
    lastTestError: row.lastTestError,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type TargetFields = {
  name: string
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  serverSideEncryption: boolean
  accessKeyId: string
  secretAccessKey?: string
}

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; detail: string }

const bad = (field: string, detail: string): Parsed<never> => ({ ok: false, field, detail })

function text(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field]
  return typeof v === 'string' ? v.trim() : undefined
}

function checkName(name: string | undefined): string | null {
  if (!name || name.length > MAX_TARGET_NAME_LENGTH) {
    return `The name must be 1 to ${MAX_TARGET_NAME_LENGTH} characters`
  }
  return null
}

function checkBucketFields(f: {
  region: string | undefined
  bucket: string | undefined
  prefix: string
}): { field: string; detail: string } | null {
  if (!f.bucket || !BUCKET_NAME_RE.test(f.bucket)) {
    return {
      field: 'bucket',
      detail: 'The bucket name must be 3 to 63 lower-case letters, digits, dots or dashes',
    }
  }
  if (!f.region || !REGION_RE.test(f.region)) {
    return { field: 'region', detail: 'The region must be letters, digits and dashes, such as us-east-1' }
  }
  if (f.prefix !== '' && (!PREFIX_RE.test(f.prefix) || f.prefix.split('/').includes('..'))) {
    return {
      field: 'prefix',
      detail: 'The folder must be letters, digits, dots, dashes or underscores, without a leading or trailing slash',
    }
  }
  return null
}

function checkCredentials(accessKeyId: string | undefined, secret: string | undefined, required: boolean) {
  if (!accessKeyId || !ACCESS_KEY_RE.test(accessKeyId)) {
    return { field: 'accessKeyId', detail: 'The access key id is required (no spaces)' }
  }
  if (secret === undefined) {
    return required ? { field: 'secretAccessKey', detail: 'The secret access key is required' } : null
  }
  if (secret.length === 0 || secret.length > MAX_SECRET_KEY_LENGTH) {
    return { field: 'secretAccessKey', detail: 'The secret access key must be 1 to 256 characters' }
  }
  return null
}

function flag(body: Record<string, unknown>, field: string, fallback: boolean): boolean | null {
  const v = body[field]
  if (v === undefined) return fallback
  return typeof v === 'boolean' ? v : null
}

/** Check a create or update body in plain words. On update the secret may be left out (kept). */
export function parseTargetBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
  current?: BackupTargetRow
): Parsed<TargetFields> {
  const name = text(body, 'name') ?? current?.name
  const endpoint = (text(body, 'endpoint') ?? current?.endpoint ?? '').replace(/\/+$/, '')
  const region = text(body, 'region') ?? current?.region
  const bucket = text(body, 'bucket') ?? current?.bucket
  const prefix = (text(body, 'prefix') ?? current?.prefix ?? '').replace(/^\/+|\/+$/g, '')
  const accessKeyId = text(body, 'accessKeyId') ?? current?.accessKeyId
  const secret = typeof body.secretAccessKey === 'string' ? body.secretAccessKey : undefined
  const pathStyle = flag(body, 'pathStyle', current?.isPathStyle ?? true)
  const sse = flag(body, 'serverSideEncryption', current?.isServerSideEncrypted ?? false)

  const nameIssue = checkName(name)
  if (nameIssue) return bad('name', nameIssue)
  const endpointIssue = endpointRefusal(endpoint)
  if (endpointIssue) return bad('endpoint', endpointIssue)
  const bucketIssue = checkBucketFields({ region, bucket, prefix })
  if (bucketIssue) return bad(bucketIssue.field, bucketIssue.detail)
  if (pathStyle === null || sse === null) {
    return bad('pathStyle', 'pathStyle and serverSideEncryption must be true or false')
  }
  const credentialIssue = checkCredentials(accessKeyId, secret, mode === 'create')
  if (credentialIssue) return bad(credentialIssue.field, credentialIssue.detail)
  return {
    ok: true,
    value: {
      name: name!,
      endpoint,
      region: region!,
      bucket: bucket!,
      prefix,
      pathStyle,
      serverSideEncryption: sse,
      accessKeyId: accessKeyId!,
      ...(secret === undefined ? {} : { secretAccessKey: secret }),
    },
  }
}

export async function listTargets(db: Db, organizationId: string): Promise<BackupTargetRow[]> {
  return await db
    .select()
    .from(backupTarget)
    .where(eq(backupTarget.organizationId, organizationId))
    .orderBy(asc(backupTarget.name))
}

export async function findTarget(
  db: Db,
  organizationId: string,
  targetId: string
): Promise<BackupTargetRow | null> {
  const [row] = await db
    .select()
    .from(backupTarget)
    .where(and(eq(backupTarget.id, targetId), eq(backupTarget.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

export async function insertTarget(
  db: Db,
  params: { organizationId: string; userId: string; fields: TargetFields; sealed: string }
): Promise<BackupTargetRow> {
  const f = params.fields
  const [row] = await db
    .insert(backupTarget)
    .values({
      organizationId: params.organizationId,
      name: f.name,
      endpoint: f.endpoint,
      region: f.region,
      bucket: f.bucket,
      prefix: f.prefix,
      isPathStyle: f.pathStyle,
      isServerSideEncrypted: f.serverSideEncryption,
      accessKeyId: f.accessKeyId,
      secretKeySealed: params.sealed,
      createdBy: params.userId,
    })
    .returning()
  return row!
}

/** Update a target. Changing where it points clears the last test, which no longer applies. */
export async function updateTarget(
  db: Db,
  current: BackupTargetRow,
  fields: TargetFields,
  sealed: string | null
): Promise<BackupTargetRow> {
  const moved =
    current.endpoint !== fields.endpoint ||
    current.region !== fields.region ||
    current.bucket !== fields.bucket ||
    current.prefix !== fields.prefix ||
    current.accessKeyId !== fields.accessKeyId ||
    sealed !== null
  const [row] = await db
    .update(backupTarget)
    .set({
      name: fields.name,
      endpoint: fields.endpoint,
      region: fields.region,
      bucket: fields.bucket,
      prefix: fields.prefix,
      isPathStyle: fields.pathStyle,
      isServerSideEncrypted: fields.serverSideEncryption,
      accessKeyId: fields.accessKeyId,
      ...(sealed === null ? {} : { secretKeySealed: sealed }),
      ...(moved ? { lastTestedAt: null, isLastTestOk: null, lastTestError: null } : {}),
    })
    .where(eq(backupTarget.id, current.id))
    .returning()
  return row!
}

/** Where a target is used: the default and the clusters that name it. */
export async function targetUsage(
  db: Db,
  targetId: string
): Promise<{ isDefault: boolean; managedIds: string[] }> {
  const rows = await db
    .select({ managedId: backupTargetAssignment.managedId })
    .from(backupTargetAssignment)
    .where(eq(backupTargetAssignment.targetId, targetId))
  return {
    isDefault: rows.some((r) => r.managedId === null),
    managedIds: rows.flatMap((r) => (r.managedId ? [r.managedId] : [])),
  }
}

export async function deleteTarget(db: Db, targetId: string): Promise<void> {
  await db.delete(backupTarget).where(eq(backupTarget.id, targetId))
}

export async function recordTargetTest(
  db: Db,
  targetId: string,
  result: { ok: boolean; error?: string },
  at: string
): Promise<void> {
  await db
    .update(backupTarget)
    .set({
      lastTestedAt: at,
      isLastTestOk: result.ok,
      lastTestError: result.ok ? null : (result.error ?? 'The test failed').slice(0, 300),
    })
    .where(eq(backupTarget.id, targetId))
}

/** Seal a secret access key for storage. */
export async function sealSecretKey(
  dataEncryptionSecrets: DerivedSecretsConfig,
  secretAccessKey: string
): Promise<string> {
  return await encryptSecret(dataEncryptionSecrets, secretAccessKey)
}

export type OrgAssignments = {
  defaultTargetId: string | null
  /** One entry per cluster with its own choice; `targetId` null means "no copy". */
  clusters: { managedId: string; targetId: string | null }[]
}

export async function readAssignments(db: Db, organizationId: string): Promise<OrgAssignments> {
  const rows = await db
    .select({
      managedId: backupTargetAssignment.managedId,
      targetId: backupTargetAssignment.targetId,
    })
    .from(backupTargetAssignment)
    .where(eq(backupTargetAssignment.organizationId, organizationId))
  return {
    defaultTargetId: rows.find((r) => r.managedId === null)?.targetId ?? null,
    clusters: rows.flatMap((r) =>
      r.managedId ? [{ managedId: r.managedId, targetId: r.targetId }] : []
    ),
  }
}

export async function setOrganizationDefault(
  db: Db,
  organizationId: string,
  targetId: string | null
): Promise<void> {
  if (targetId === null) {
    await db
      .delete(backupTargetAssignment)
      .where(
        and(
          eq(backupTargetAssignment.organizationId, organizationId),
          isNull(backupTargetAssignment.managedId)
        )
      )
    return
  }
  await db
    .insert(backupTargetAssignment)
    .values({ organizationId, managedId: null, targetId })
    .onConflictDoUpdate({
      target: [backupTargetAssignment.organizationId],
      targetWhere: isNull(backupTargetAssignment.managedId),
      set: { targetId },
    })
}

/** `inherit` removes the cluster's own row; `none` and a target id write one. */
export async function setClusterChoice(
  db: Db,
  params: { organizationId: string; managedId: string; choice: 'inherit' | 'none' | string }
): Promise<void> {
  if (params.choice === 'inherit') {
    await db.delete(backupTargetAssignment).where(eq(backupTargetAssignment.managedId, params.managedId))
    return
  }
  const targetId = params.choice === 'none' ? null : params.choice
  await db
    .insert(backupTargetAssignment)
    .values({ organizationId: params.organizationId, managedId: params.managedId, targetId })
    .onConflictDoUpdate({
      target: [backupTargetAssignment.managedId],
      targetWhere: sql`managed_id IS NOT NULL`,
      set: { targetId },
    })
}

export type EffectiveChoice = {
  /** Where the choice came from: the cluster's own row, the organization default, or nowhere. */
  source: 'cluster' | 'organization' | 'none'
  target: BackupTargetRow | null
}

async function loadTarget(db: Db, targetId: string | null): Promise<BackupTargetRow | null> {
  if (!targetId) return null
  const [row] = await db.select().from(backupTarget).where(eq(backupTarget.id, targetId)).limit(1)
  return row ?? null
}

/**
 * The target a cluster's backups are copied to: its own choice (even "none"),
 * else the organization default, else nothing.
 */
export async function resolveEffectiveTarget(
  db: Db,
  managedId: string,
  organizationId?: string
): Promise<EffectiveChoice> {
  const [own] = await db
    .select({ targetId: backupTargetAssignment.targetId })
    .from(backupTargetAssignment)
    .where(eq(backupTargetAssignment.managedId, managedId))
    .limit(1)
  if (own) {
    const target = await loadTarget(db, own.targetId)
    return { source: target ? 'cluster' : 'none', target }
  }
  const orgId = organizationId ?? (await resolveManagedHomeOrganizationId(db, managedId))
  const [fallback] = await db
    .select({ targetId: backupTargetAssignment.targetId })
    .from(backupTargetAssignment)
    .where(
      and(eq(backupTargetAssignment.organizationId, orgId), isNull(backupTargetAssignment.managedId))
    )
    .limit(1)
  const target = await loadTarget(db, fallback?.targetId ?? null)
  return { source: target ? 'organization' : 'none', target }
}

export type DaemonRecipient = { serverId: string; keyId: string }

/** The recipient to seal for, or null when the host cannot take a copy target (older daemon or no active key). */
export async function copyRecipientFor(db: Db, serverId: string): Promise<DaemonRecipient | null> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  const features = state?.projection?.features ?? []
  if (!state || !features.includes(BACKUP_S3_COPY_FEATURE) || !isDaemonKeyActive(state.key)) {
    return null
  }
  return { serverId, keyId: state.key.id }
}

export type CopyResealDeps = { secretsConfig: SecretsConfig; dataEncryptionSecrets: DerivedSecretsConfig }

/** A target as one host receives it, with the secret key sealed to that host's daemon key. */
export async function toWireTarget(
  row: BackupTargetRow,
  recipient: DaemonRecipient,
  deps: CopyResealDeps
): Promise<BackupCopyTargetWire> {
  return {
    targetId: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    pathStyle: row.isPathStyle,
    serverSideEncryption: row.isServerSideEncrypted,
    accessKeyId: row.accessKeyId,
    secretKeyEnvelope: await resealSecretForDaemon(
      deps.secretsConfig,
      deps.dataEncryptionSecrets,
      recipient,
      row.secretKeySealed
    ),
  }
}

/** Test seam: the plain secret of a stored target (used only to prove sealing in tests). */
export async function openStoredSecretForTest(
  dataEncryptionSecrets: DerivedSecretsConfig,
  row: BackupTargetRow
): Promise<string> {
  return await decryptSecret(dataEncryptionSecrets, row.secretKeySealed)
}

/** Hosts of the organization's managed databases: where a change to the default must be pushed. */
export async function managedHostsOfOrganization(
  db: Db,
  organizationId: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serverId: managed.serverId })
    .from(managed)
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(workspace.organizationId, organizationId))
  return rows.flatMap((r) => (r.serverId ? [r.serverId] : []))
}
