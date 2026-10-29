/**
 * Org TLS library routes (`/api/client/v1/tls` and `/tls/ca`).
 *
 * Organization CA material is for hosting/managed-DB leaves only. These
 * handlers must never read or write the **Platform CA** files under
 * `<stateDir>/tls/` (see `src/lib/tls/AGENTS.md`).
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import type { Db } from '../../db/connection.ts'
import {
  assembleTlsMetadata,
  parseTlsOptions,
  splitTlsMetadata,
  type TlsOptions,
  type TlsSource,
} from '../../lib/tls/index.ts'
import { organization, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import {
  OriginCertificateRefusal,
  readProviderOrigin,
  revokeOriginCertificate,
} from '../../features/tunnels/origin-certificate.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import type { TunnelProvider } from '../../features/tunnels/vocabulary.ts'
import { providerFailure } from '../organizations/carrier-routes.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  parseName,
  parseJsonBody,
  requireDbSessionAndOrg,
} from '../shared.ts'
import {
  parseOrganizationOptions,
  resolveAcmeEnabled,
} from '../../features/organizations/organization-options.ts'
import { hierarchyDeleteHasChildrenResponse, runHierarchyDelete } from '../hierarchy-delete.ts'
import {
  applyTlsOptionsPatch,
  buildCreateTlsMaterial,
  classifyTlsInsertConflict,
  type CreateTlsFailure,
  type CreateTlsMaterial,
  isCreateTlsFailure,
  isOrganizationCaUniqueViolation,
  isTlsFingerprintUniqueViolation,
  isTlsUuid,
  materialFromOrganizationCa,
  organizationCaDownloadHeaders,
  parseSource,
  rotationConflictResponse,
  rotationStatusResponse,
  shouldRevokeTlsFromBody,
  tlsFailurePayload,
  type TlsPublicRow,
  toCaRotationApiResult,
  toPublicTlsRow,
  withPreferOption,
} from './routes-helpers.ts'
import {
  loadOrganizationCaSet,
  nextOrganizationCaGeneration,
  type OrganizationCaSet,
} from '../../features/tls/organization-ca.ts'
import {
  caRotationHasMintedGeneration,
  loadLatestCaRotation,
  tryBeginCaRotation,
  updateCaRotationJournal,
  type CaRotationJournalRow,
} from './changeover-lease.ts'
import { countLeafHealthForOrganization } from './leaf-renewal-sweep.ts'
import { retireAwaitingRotation } from './rotation-retire.ts'
import { caRetireByIso } from '../../features/tls/leaf-vocabulary.ts'
import {
  type CaRotationResultRow,
  enumerateOrganizationRotationTargets,
  parseCaRotationResults,
  parseNeedsRedeploy,
  parseResumeAfterManagedId,
  runOrganizationCaRotationFanout,
} from './changeover-fanout.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { listCommandRecordsByIds } from '../../features/commands/command-records.ts'
import {
  loadReconciledRotationWithCommandRecords,
  persistSyncedRotationResults,
  rotationConvergedForRetire,
  rotationResultReason,
} from './rotation-converge.ts'

export const TLS_PUBLIC_SELECT = {
  id: tls.id,
  name: tls.name,
  source: tls.source,
  organizationId: tls.organizationId,
  status: tls.status,
  notAfter: tls.notAfter,
  fingerprintSha256: tls.fingerprintSha256,
  metadata: tls.metadata,
  options: tls.options,
  certificatePem: tls.certificatePem,
  createdAt: tls.createdAt,
  updatedAt: tls.updatedAt,
  caGeneration: tls.caGeneration,
} as const

function findActiveOrganizationCa(
  db: Db,
  organizationId: string
): Promise<OrganizationCaSet | null> {
  return loadOrganizationCaSet(db, organizationId)
}

function createTlsFailureResponse(c: Context<AppEnv>, material: CreateTlsFailure): Response {
  const payload = tlsFailurePayload(material)
  return c.json(payload.body, payload.status)
}

async function refuseTlsCreateSource(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  source: TlsSource
): Promise<Response | null> {
  if (source === 'organization_ca') {
    const existing = await findActiveOrganizationCa(db, organizationId)
    if (existing) return c.json({ error: 'organization_ca_exists' }, 409)
  }
  if (source !== 'lets_encrypt') return null
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const acmeEnabled = resolveAcmeEnabled(parseOrganizationOptions(orgRow?.options))
  if (!acmeEnabled) {
    return c.json({ error: 'lets_encrypt_not_enabled' }, 403)
  }
  return null
}

async function prepareTlsCreateMaterial(
  c: Context<AppEnv>,
  organizationId: string,
  source: TlsSource,
  body: Record<string, unknown>
): Promise<
  { name: string | null; material: CreateTlsMaterial; options: TlsOptions | null } | Response
> {
  let name: string | null
  try {
    name = parseName(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json(
      {
        error: 'Encryption unavailable — no encryption key configured',
      },
      503
    )
  }

  const material = await buildCreateTlsMaterial(source, body, dataEncryptionSecrets, organizationId)
  if (isCreateTlsFailure(material)) {
    return createTlsFailureResponse(c, material)
  }

  return {
    name,
    material,
    options: withPreferOption(material.options, body.prefer),
  }
}

async function organizationCaRowResponse(
  c: Context<AppEnv>,
  db: Db,
  set: OrganizationCaSet
): Promise<Response> {
  const publicRow = toPublicTlsRow(set.tls, {
    trustBundlePem: set.trustBundlePem,
  })
  if (!publicRow) return c.json({ error: 'Invalid request' }, 500)
  const { dueCount, staleCount } = await countLeafHealthForOrganization(
    db,
    set.tls.organizationId,
    {
      activeCaGeneration: set.signer.caGeneration,
    }
  )
  return c.json({
    tls: publicRow,
    trustBundlePem: set.trustBundlePem,
    leafHealth: {
      dueCount,
      staleCount,
      caGeneration: set.signer.caGeneration,
      caNotAfter: set.tls.notAfter,
    },
  })
}

/**
 * Ensure-or-create the organization CA row inside a transaction, racing
 * against a concurrent ensure. Returns the row id, or a `Response` when a
 * concurrent create already won (existing row reused / unique violation).
 */
async function ensureOrganizationCaId(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  material: CreateTlsMaterial
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(material.metadata)
  try {
    return await db.transaction(async (tx) => {
      // Race: another concurrent ensure may have inserted first.
      const race = await loadOrganizationCaSet(tx, organizationId)
      if (race) return race.signer.id

      const caGeneration = await nextOrganizationCaGeneration(tx, organizationId)
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId,
          name: 'Organization CA',
          source: 'organization_ca',
          certificatePem: material.certificatePem,
          privateKeyPem: material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: null,
          caState: 'active',
          caGeneration,
        })
        .returning({ id: tls.id })
      return inserted.id
    })
  } catch (err) {
    if (isOrganizationCaUniqueViolation(err) || isTlsFingerprintUniqueViolation(err)) {
      const raced = await loadOrganizationCaSet(db, organizationId)
      if (raced) return organizationCaRowResponse(c, db, raced)
      return c.json({ error: 'organization_ca_exists' }, 409)
    }
    throw err
  }
}

async function insertTlsRow(
  c: Context<AppEnv>,
  db: Db,
  params: {
    organizationId: string
    name: string | null
    source: TlsSource
    material: CreateTlsMaterial
    options: TlsOptions | null
  }
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(params.material.metadata)
  try {
    return await db.transaction(async (tx) => {
      if (params.source === 'organization_ca') {
        const race = await loadOrganizationCaSet(tx, params.organizationId)
        if (race) {
          throw Object.assign(new Error('organization_ca_exists'), {
            code: 'ORGANIZATION_CA_EXISTS',
          })
        }
      }
      const caGeneration =
        params.source === 'organization_ca'
          ? await nextOrganizationCaGeneration(tx, params.organizationId)
          : null
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId: params.organizationId,
          name: params.name,
          source: params.source,
          certificatePem: params.material.certificatePem,
          privateKeyPem: params.material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: params.options,
          ...(caGeneration === null ? {} : { caState: 'active' as const, caGeneration }),
        })
        .returning({ id: tls.id })
      return inserted.id
    })
  } catch (err) {
    const conflict = classifyTlsInsertConflict(err)
    if (conflict) {
      return c.json({ error: conflict.error }, conflict.status)
    }
    throw err
  }
}

type TlsDb = Db

function conflictJson(
  c: Context<AppEnv>,
  reason: Parameters<typeof rotationConflictResponse>[0]
): Response {
  const payload = rotationConflictResponse(reason)
  return c.json(payload.body, payload.status)
}

async function markRotationFailed(db: TlsDb, rotationId: string): Promise<void> {
  await updateCaRotationJournal(db, rotationId, { state: 'failed' })
}

async function mintRotatedOrganizationCa(
  db: TlsDb,
  organizationId: string,
  material: CreateTlsMaterial
): Promise<{ id: string; fromGeneration: number; toGeneration: number }> {
  const { columns, residual } = splitTlsMetadata(material.metadata)
  const now = new Date().toISOString()
  return await db.transaction(async (tx) => {
    const current = await loadOrganizationCaSet(tx, organizationId)
    const fromGeneration = current?.signer.caGeneration ?? 0
    const toGeneration = await nextOrganizationCaGeneration(tx, organizationId)
    await tx
      .update(tls)
      .set({ caState: 'retired', updatedAt: now })
      .where(
        and(
          eq(tls.organizationId, organizationId),
          eq(tls.source, 'organization_ca'),
          eq(tls.caState, 'active')
        )
      )
    const [inserted] = await tx
      .insert(tls)
      .values({
        organizationId,
        name: 'Organization CA',
        source: 'organization_ca',
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPemSealed,
        status: columns.status,
        notAfter: columns.notAfter,
        fingerprintSha256: columns.fingerprintSha256,
        metadata: residual,
        options: null,
        caState: 'active',
        caGeneration: toGeneration,
      })
      .returning({ id: tls.id })
    return { id: inserted.id, fromGeneration, toGeneration }
  })
}

async function resolveRotatedOrganizationCa(
  c: Context<AppEnv>,
  db: TlsDb,
  params: {
    organizationId: string
    journal: CaRotationJournalRow
    dataEncryptionSecrets: DerivedSecretsConfig
  }
): Promise<{ activeCaId: string; generation: number } | Response> {
  if (caRotationHasMintedGeneration(params.journal)) {
    const current = await findActiveOrganizationCa(db, params.organizationId)
    if (!current) {
      await markRotationFailed(db, params.journal.id)
      return c.json({ error: 'Not found' }, 404)
    }
    return {
      activeCaId: current.signer.id,
      generation: params.journal.toCaGeneration,
    }
  }

  const material = await materialFromOrganizationCa(params.dataEncryptionSecrets, {
    organizationId: params.organizationId,
  })
  if (isCreateTlsFailure(material)) {
    await markRotationFailed(db, params.journal.id)
    return createTlsFailureResponse(c, material)
  }

  try {
    const minted = await mintRotatedOrganizationCa(db, params.organizationId, material)
    await updateCaRotationJournal(db, params.journal.id, {
      fromCaGeneration: minted.fromGeneration,
      toCaGeneration: minted.toGeneration,
    })
    return { activeCaId: minted.id, generation: minted.toGeneration }
  } catch (err) {
    await markRotationFailed(db, params.journal.id)
    if (isTlsFingerprintUniqueViolation(err)) {
      return c.json({ error: 'tls_fingerprint_conflict' }, 409)
    }
    throw err
  }
}

export function overlayRotationResults(
  rows: readonly CaRotationResultRow[],
  records: readonly { id: string; status: string; error: string | null }[]
) {
  const byId = new Map(records.map((record) => [record.id, record]))
  return rows.map((row) => {
    const record = row.commandId ? byId.get(row.commandId) : undefined
    const effectiveStatus = row.status === 'skipped' ? 'skipped' : (record?.status ?? row.status)
    const effectiveError = row.error ?? record?.error ?? undefined
    const reason = rotationResultReason({
      row,
      effectiveStatus,
      effectiveError,
    })
    return toCaRotationApiResult({
      serverId: row.serverId,
      kind: row.kind,
      managedId: row.managedId,
      status: effectiveStatus,
      commandId: row.commandId,
      error: effectiveError,
      reason,
    })
  })
}

export function rotationCommandsSucceeded(
  rows: readonly CaRotationResultRow[],
  records: readonly { id: string; status: string; error?: string | null }[],
  liveMembers?: Parameters<typeof rotationConvergedForRetire>[2]
): boolean {
  return rotationConvergedForRetire(rows, records, liveMembers)
}

export function rotationNeedsCommands(targets: {
  managedIds: readonly string[]
  ingressServerIds: readonly string[]
}): boolean {
  return targets.managedIds.length > 0 || targets.ingressServerIds.length > 0
}

async function runRotationFanoutStep(
  c: Context<AppEnv>,
  db: TlsDb,
  params: {
    organizationId: string
    rotationId: string
    actorId: string
    cursor?: string
    priorResults?: CaRotationResultRow[]
    priorNeedsRedeploy?: { serverId: string; environmentId: string }[]
  }
): Promise<
  | {
      results: CaRotationResultRow[]
      needsRedeploy: { serverId: string; environmentId: string }[]
    }
  | Response
> {
  const targets = await enumerateOrganizationRotationTargets(db, params.organizationId)
  if (!rotationNeedsCommands(targets)) {
    await updateCaRotationJournal(db, params.rotationId, {
      state: 'awaiting_retire',
      retireBy: caRetireByIso(),
    })
    return {
      results: params.priorResults ?? [],
      needsRedeploy: params.priorNeedsRedeploy ?? [],
    }
  }

  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) {
    await markRotationFailed(db, params.rotationId)
    return commandQueue
  }

  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    await markRotationFailed(db, params.rotationId)
    return c.json(
      {
        error: 'Encryption unavailable — no encryption key configured',
      },
      503
    )
  }

  try {
    const outcome = await runOrganizationCaRotationFanout(c, db, commandQueue, {
      organizationId: params.organizationId,
      secretsConfig,
      dataEncryptionSecrets,
      actorType: 'user',
      actorId: params.actorId,
      rotationId: params.rotationId,
      cursor: params.cursor,
      priorResults: params.priorResults,
      priorNeedsRedeploy: params.priorNeedsRedeploy,
    })
    if (outcome.complete) {
      await updateCaRotationJournal(db, params.rotationId, {
        state: 'awaiting_retire',
        retireBy: caRetireByIso(),
      })
    }
    return { results: outcome.results, needsRedeploy: outcome.needsRedeploy }
  } catch (err) {
    await markRotationFailed(db, params.rotationId)
    throw err
  }
}

type TlsRowPatch = {
  name?: string | null
  options?: TlsOptions | null
  status?: string
  /** Set to null when a Let's Encrypt row is revoked: the stored pair is no longer needed. */
  certificatePem?: null
  privateKeyPem?: null
  issuedByServerId?: null
  fingerprintSha256?: null
  notAfter?: string
  metadata?: Record<string, unknown>
  updatedAt: string
}

export function buildTlsRowPatch(
  body: Record<string, unknown>,
  existing: {
    options: unknown
    status: string
    notAfter: string | null
    fingerprintSha256: string | null
    metadata: unknown
    source: string
  }
): { ok: true; patch: TlsRowPatch } | { ok: false; error: string; status: 400 | 409 | 500 } {
  const patch: TlsRowPatch = { updatedAt: new Date().toISOString() }

  if (body.name !== undefined) {
    try {
      patch.name = parseName(body)
    } catch {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
  }

  const optionsPatch = applyTlsOptionsPatch(parseTlsOptions(existing.options) ?? {}, body)
  if (!optionsPatch.ok) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (optionsPatch.changed) {
    patch.options = optionsPatch.options
  }

  if (shouldRevokeTlsFromBody(body)) {
    if (existing.source === 'provider_origin') {
      return { ok: false, error: 'provider_origin_managed', status: 409 }
    }
    if (existing.source === 'organization_ca') {
      return {
        ok: false,
        error: 'organization_ca_retire_required',
        status: 409,
      }
    }
    const metadata = assembleTlsMetadata(
      {
        status: existing.status,
        notAfter: existing.notAfter,
        fingerprintSha256: existing.fingerprintSha256,
      },
      existing.metadata
    )
    if (!metadata) {
      return { ok: false, error: 'Invalid request', status: 500 }
    }
    patch.status = 'revoked'
    if (existing.source === 'lets_encrypt') {
      patch.certificatePem = null
      patch.privateKeyPem = null
      patch.issuedByServerId = null
      patch.fingerprintSha256 = null
      patch.notAfter = new Date(0).toISOString()
      const residual = existing.metadata as { acme?: Record<string, unknown> }
      const acme = { ...residual.acme }
      delete acme.storedNames
      delete acme.issuedByServerId
      patch.metadata = { ...residual, acme }
    }
  }

  return { ok: true, patch }
}

/**
 * Deleting a certificate a tunnel provider issued: revoked at the provider
 * through the shared token selector, then the row goes. Refused while a site
 * pins it. A row without a provider link was not issued here and is never
 * touched.
 */
async function deleteProviderOriginCertificate(
  c: Context<AppEnv>,
  target: { db: Db; organizationId: string; row: typeof tls.$inferSelect },
  registry: TunnelAdapterRegistry
): Promise<Response> {
  const { db, organizationId, row } = target
  const link = readProviderOrigin(row.metadata)
  if (!link) return c.json({ error: 'provider_origin_managed' }, 409)
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
  try {
    const { revokedWithBadgeId } = await revokeOriginCertificate({
      db,
      secrets,
      adapter: registry(link.provider as TunnelProvider),
      row,
    })
    const session = c.get('session')
    await recordAudit(db, {
      organizationId,
      actorUserId: session?.userId ?? null,
      actorEmail: session?.email ?? null,
      action: 'origin_certificate.revoke',
      targetType: 'organization',
      targetId: row.id,
      context: { carrierId: link.carrierId, zone: link.zoneName, revokedWithBadgeId },
    })
    return c.json({ ok: true as const })
  } catch (err) {
    if (err instanceof OriginCertificateRefusal) {
      const message =
        err.error === 'tls_in_use'
          ? 'A site still uses this certificate. Choose another certificate for that site first, then delete this one.'
          : err.message
      return c.json({ error: err.error, message }, err.error === 'secrets_unavailable' ? 503 : 409)
    }
    if (err instanceof TunnelProviderError) return providerFailure(c, err)
    throw err
  }
}

export function registerTlsRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  fetchImpl?: typeof fetch
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tls routes')
  }
  const secrets = opts.secrets
  const registry = createTunnelAdapterRegistry(fetchImpl)

  router.use('/tls', createSessionMiddleware(secrets))
  router.use('/tls/*', createSessionMiddleware(secrets))
  router.use('/tls/:id', createSessionMiddleware(secrets))

  router.get('/tls', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, session, organizationId } = sessionOrg

    const visibleIds = await listVisible(db, {
      kind: 'tls',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ tls: [] })
    }

    const rows = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(and(inArray(tls.id, visibleIds), eq(tls.organizationId, organizationId)))
      .orderBy(tls.createdAt)

    const publicRows = rows
      .map((row) => toPublicTlsRow(row))
      .filter((row): row is TlsPublicRow => row !== null)

    return c.json({ tls: publicRows })
  })

  /**
   * Ensure-or-create the organization CA (at most one active row per org).
   * Managed provisioning later reuses this path without a dedicated wizard.
   */
  router.get('/tls/ca', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const existing = await findActiveOrganizationCa(db, organizationId)
    if (existing) {
      const denied = await assertCanReadOr403(c, 'tls', existing.signer.id)
      if (denied) return denied
      return organizationCaRowResponse(c, db, existing)
    }

    const deniedCreate = await assertCanCreateOr403(c, 'organization', organizationId)
    if (deniedCreate) return deniedCreate

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json(
        {
          error: 'Encryption unavailable — no encryption key configured',
        },
        503
      )
    }

    const material = await materialFromOrganizationCa(dataEncryptionSecrets, {
      organizationId,
    })
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material)
    }

    const idOrResponse = await ensureOrganizationCaId(c, db, organizationId, material)
    if (idOrResponse instanceof Response) return idOrResponse

    const created = await findActiveOrganizationCa(db, organizationId)
    if (!created) return c.json({ error: 'Not found' }, 404)
    return organizationCaRowResponse(c, db, created)
  })

  router.post('/tls/ca/rotate', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, session, organizationId } = sessionOrg

    const denied = await assertCanOr403(c, 'organization:manage', 'organization', organizationId)
    if (denied) return denied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json(
        {
          error: 'Encryption unavailable — no encryption key configured',
        },
        503
      )
    }

    const journal = await tryBeginCaRotation(db, organizationId)
    if (!journal) return conflictJson(c, 'ca_rotation_in_progress')

    const signer = await resolveRotatedOrganizationCa(c, db, {
      organizationId,
      journal,
      dataEncryptionSecrets,
    })
    if (signer instanceof Response) return signer

    let fanoutResults = parseCaRotationResults(journal.results)
    let needsRedeploy = parseNeedsRedeploy(journal.metadata)
    if (journal.state === 'in_progress') {
      const fanout = await runRotationFanoutStep(c, db, {
        organizationId,
        rotationId: journal.id,
        actorId: session.userId,
        cursor: parseResumeAfterManagedId(journal.metadata),
        priorResults: fanoutResults,
        priorNeedsRedeploy: needsRedeploy,
      })
      if (fanout instanceof Response) return fanout
      fanoutResults = fanout.results
      needsRedeploy = fanout.needsRedeploy
    }

    const synced = await persistSyncedRotationResults(c, db, {
      organizationId,
      rotationId: journal.id,
      actorId: session.userId,
      startedAt: journal.startedAt,
      rows: fanoutResults,
      enqueueGaps: true,
    })
    const commandIds = synced.flatMap((row) => (row.commandId ? [row.commandId] : []))
    const records = await listCommandRecordsByIds(db, commandIds)

    return c.json({
      ok: true as const,
      id: signer.activeCaId,
      rotationId: journal.id,
      generation: signer.generation,
      results: overlayRotationResults(synced, records),
      needsRedeploy,
    })
  })

  router.get('/tls/ca/rotation', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const journal = await loadLatestCaRotation(db, organizationId)
    if (!journal) return c.json({ error: 'Not found' }, 404)

    const { rows, records } = await loadReconciledRotationWithCommandRecords(
      db,
      organizationId,
      journal
    )
    return c.json(
      rotationStatusResponse({
        rotationId: journal.id,
        fromGeneration: journal.fromCaGeneration,
        toGeneration: journal.toCaGeneration,
        state: journal.state,
        results: overlayRotationResults(rows, records),
        retireBy: journal.retireBy,
      })
    )
  })

  router.post('/tls/ca/retire', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, session, organizationId } = sessionOrg

    const denied = await assertCanOr403(c, 'organization:manage', 'organization', organizationId)
    if (denied) return denied

    const queue = assertDispatchInfrastructure(c)
    const outcome = await retireAwaitingRotation(c, db, {
      organizationId,
      actorType: 'user',
      actorId: session.userId,
      enqueueGaps: true,
      deps: {
        commandQueue: queue instanceof Response ? null : queue,
        secretsConfig: c.get('secretsConfig') ?? null,
        dataEncryptionSecrets: c.get('dataEncryptionSecrets') ?? null,
      },
    })
    if (!outcome.ok) {
      const payload = rotationConflictResponse(outcome.reason)
      return c.json(
        outcome.outstanding === undefined
          ? payload.body
          : { ...payload.body, outstandingLeaves: outcome.outstanding },
        payload.status
      )
    }
    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email ?? null,
      action: 'tls.ca.retire',
      targetType: 'organization',
      targetId: organizationId,
      context: { rotationId: outcome.rotationId, by: 'owner' },
    })
    return c.json({ ok: true as const, rotationId: outcome.rotationId })
  })

  router.get('/tls/ca/download', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const set = await findActiveOrganizationCa(db, organizationId)
    if (!set?.trustBundlePem) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'tls', set.signer.id)
    if (denied) return denied

    return new Response(set.trustBundlePem, {
      status: 200,
      headers: organizationCaDownloadHeaders(organizationId),
    })
  })

  router.get('/tls/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'tls', id)
    if (denied) return denied

    const [row] = await db.select(TLS_PUBLIC_SELECT).from(tls).where(eq(tls.id, id)).limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)
    const publicRow = toPublicTlsRow(row)
    if (!publicRow) return c.json({ error: 'Invalid request' }, 500)

    return c.json({ tls: publicRow })
  })

  router.post('/tls', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const source = parseSource(body.source)
    if (!source) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const sourceDenied = await refuseTlsCreateSource(c, db, organizationId, source)
    if (sourceDenied) return sourceDenied

    const prepared = await prepareTlsCreateMaterial(c, organizationId, source, body)
    if (prepared instanceof Response) return prepared

    const idOrResponse = await insertTlsRow(c, db, {
      organizationId,
      name: prepared.name,
      source,
      material: prepared.material,
      options: prepared.options,
    })
    if (idOrResponse instanceof Response) return idOrResponse

    return c.json({ ok: true as const, id: idOrResponse })
  })

  router.patch('/tls/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'tls', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const [existing] = await db
      .select({
        options: tls.options,
        status: tls.status,
        notAfter: tls.notAfter,
        fingerprintSha256: tls.fingerprintSha256,
        metadata: tls.metadata,
        source: tls.source,
      })
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const built = buildTlsRowPatch(body, existing)
    if (!built.ok) {
      return c.json({ error: built.error }, built.status)
    }

    await db.update(tls).set(built.patch).where(eq(tls.id, id))
    return c.json({ ok: true as const })
  })

  router.delete('/tls/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const id = c.req.param('id')
    if (!isTlsUuid(id)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'tls', id)
    if (denied) return denied

    // A certificate a tunnel provider issued is revoked there first (see features/tunnels).
    const [existing] = await db.select().from(tls).where(eq(tls.id, id))
    if (existing?.source === 'provider_origin') {
      return await deleteProviderOriginCertificate(
        c,
        { db, organizationId, row: existing },
        registry
      )
    }
    // The Organization CA is replaced with Rotate and retired with POST /tls/ca/retire.
    // Deleting it would let the next managed apply mint a new CA silently, breaking
    // clients pinned to the old one and orphaning the server certificates it signed.
    if (existing?.source === 'organization_ca') {
      return c.json(
        {
          error: 'tls_organization_ca',
          message:
            "The Organization CA can't be deleted. Use Rotate on the Organization CA panel to replace it.",
        },
        409
      )
    }

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(tls).where(eq(tls.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
