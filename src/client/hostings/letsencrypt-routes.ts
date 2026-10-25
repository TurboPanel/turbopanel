/**
 * One-click Let's Encrypt for a hosting (the "domain" row in the panel).
 *
 * - `PUT /hostings/:id/use-letsencrypt` - check DNS, then pin a managed
 *   Let's Encrypt certificate (or remember the request until DNS is ready).
 *   A pinned certificate is sent to the servers at once by a hostings-only
 *   apply (no build, no restart; `letsencrypt-apply.ts`). When that cannot be
 *   queued (a server offline, a deploy running, nothing deployed yet) the
 *   answer carries `needsDeploy: true` and the next deploy starts it.
 * - `GET /hostings/:id/dns-check` - the same DNS check, read-only.
 * - `PATCH /hostings/:id` (answered by `routes.ts`) - a library pick of a
 *   Let's Encrypt certificate queues the same hostings-only apply.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDaemonCellRegistry, getDb, type Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  letsEncryptNames,
  letsEncryptRefusal,
} from '../../features/hostings/hosting-certificate.ts'
import {
  checkHostingDns,
  type DnsLookup,
  runtimeDnsLookup,
} from '../../features/hostings/hosting-dns-check.ts'
import {
  parseHostingOptions,
  readHostingWwwMode,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../../features/hostings/hosting-options.ts'
import { requestLetsEncrypt } from '../../features/hostings/use-letsencrypt.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { assertNotSystemOwnedOr403, getOrgId, parseJsonBody } from '../shared.ts'
import { assertHostingNotComposeOwnedOr409 } from './routes-helpers.ts'
import {
  createLetsEncryptStore,
  loadAcmeEnabled,
  loadHostingCertificates,
} from './letsencrypt-store.ts'
import {
  applyLibraryLetsEncryptPick,
  type HostingApplyDeps,
  type HostingApplyOutcome,
  type HostingApplyParams,
  queueHostingCertificateApply,
} from './letsencrypt-apply.ts'

export type HostingLetsEncryptDeps = {
  lookup?: DnsLookup
  now?: () => Date
  /** Where the hostings-only apply is queued; defaults to the request's queue and registry. */
  applyDeps?: (c: Context<AppEnv>) => HostingApplyDeps
}

function requestApplyDeps(c: Context<AppEnv>): HostingApplyDeps {
  return { commandQueue: getCommandQueue(c), registry: getDaemonCellRegistry(c) }
}

type HostingReadRow = {
  id: string
  tlsId: string | null
  options: unknown
  metadata: unknown
  updatedAt: string
}

function isHostingReadRow(value: unknown): value is HostingReadRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { updatedAt?: unknown }).updatedAt === 'string'
  )
}

/**
 * Adds the derived `certificate` block to what `GET /hostings` and
 * `GET /hostings/:id` return, so both reads say the same thing. Registered
 * before the hosting routes: it lets them answer, then enriches the answer.
 */
function enrichHostingReads(now: () => Date): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    const db = getDb(c)
    const session = c.get('session')
    if (c.req.method !== 'GET' || !db || !session || c.res.status !== 200) return
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return
    const body = (await c.res.clone().json()) as Record<string, unknown>
    const single = body.hosting
    const list = body.hostings
    const rows = (Array.isArray(list) ? list : [single]).filter(isHostingReadRow)
    // The hosting reads do not carry `pending_at`; the waiting request is read here.
    const pendingRows =
      rows.length === 0
        ? []
        : await db
            .select({ id: hosting.id, pendingAt: hosting.pendingAt })
            .from(hosting)
            .where(
              inArray(
                hosting.id,
                rows.map((row) => row.id)
              )
            )
    const pendingById = new Map(pendingRows.map((row) => [row.id, row.pendingAt]))
    const certificates = await loadHostingCertificates(
      db,
      orgResult,
      rows.map((row) => ({ ...row, pendingAt: pendingById.get(row.id) ?? null })),
      now()
    )
    const withCertificate = (row: HostingReadRow) => ({
      ...row,
      certificate: certificates.get(row.id) ?? null,
    })
    const enriched = Array.isArray(list)
      ? { ...body, hostings: list.filter(isHostingReadRow).map(withCertificate) }
      : { ...body, hosting: isHostingReadRow(single) ? withCertificate(single) : single }
    c.res = c.json(enriched)
  }
}

/**
 * Sends a newly pinned certificate to the servers; `null` when nothing new was
 * pinned (still waiting for DNS, or a repeat click on the same pin).
 */
function applyIfNewPin(
  c: Context<AppEnv>,
  db: Db,
  result: { outcome: 'pinned'; changed: boolean } | { outcome: 'waiting' },
  params: HostingApplyParams,
  deps: HostingApplyDeps
): Promise<HostingApplyOutcome | null> {
  if (result.outcome !== 'pinned' || !result.changed) return Promise.resolve(null)
  return queueHostingCertificateApply(c, db, params, deps)
}

/**
 * A pin the servers still have to learn about: a new pin whose apply was not
 * queued, or a repeat click on a pin no deploy has picked up yet.
 */
function pinNeedsDeploy(
  outcome: 'pinned' | 'waiting',
  apply: HostingApplyOutcome | null,
  derived: boolean | undefined
): boolean {
  if (outcome !== 'pinned') return false
  return apply === null ? derived !== false : apply !== 'queued'
}

function requestAuditContext(
  outcome: 'pinned' | 'waiting',
  www: string,
  apply: HostingApplyOutcome | null
): Record<string, string> {
  return apply === null ? { outcome, www } : { outcome, www, apply }
}

/**
 * Same gate as PATCH /hostings/:id: this organization's row, manager, not
 * system owned, and not compose owned unless compose itself asks for a Let's
 * Encrypt certificate (`tls.mode: automatic`), where Try again re-pins the row
 * compose already chose.
 */
async function refuseHostingWrite(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  id: string
): Promise<Response | null> {
  if ((await resolveEntityOrganizationId(db, 'hosting', id)) !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const denied = await assertCanOr403(c, 'organization:manage', 'hosting', id)
  if (denied) return denied
  const immutable = await assertNotSystemOwnedOr403(c, 'hosting', id)
  if (immutable) return immutable
  return assertHostingNotComposeOwnedOr409(c, db, id, { allowAutomaticTls: true })
}

export function registerHostingLetsEncryptRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  deps: HostingLetsEncryptDeps = {}
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  const secrets = opts.secrets
  const lookup = deps.lookup ?? runtimeDnsLookup()
  const now = deps.now ?? (() => new Date())
  const applyDeps = deps.applyDeps ?? requestApplyDeps

  router.use('/hostings', enrichHostingReads(now))
  router.use('/hostings/:id', enrichHostingReads(now))
  router.use('/hostings/:id', applyLibraryLetsEncryptPick(applyDeps))
  router.use('/hostings/:id/use-letsencrypt', createSessionMiddleware(secrets))
  router.use('/hostings/:id/dns-check', createSessionMiddleware(secrets))

  router.put('/hostings/:id/use-letsencrypt', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const refused = await refuseHostingWrite(c, db, organizationId, id)
    if (refused) return refused

    // The body is accepted for older clients but carries nothing: the www
    // setting lives on the hosting itself (`options.www`).
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const [row] = await db
      .select({
        id: hosting.id,
        tlsId: hosting.tlsId,
        options: hosting.options,
        metadata: hosting.metadata,
        pendingAt: hosting.pendingAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const www = readHostingWwwMode(row.options)
    const result = await requestLetsEncrypt({
      store: createLetsEncryptStore(db),
      lookup,
      now: now(),
      hosting: { ...row, organizationId },
      acmeEnabled: await loadAcmeEnabled(db, organizationId),
    })
    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          ...(result.message === undefined ? {} : { message: result.message }),
        },
        result.error === 'lets_encrypt_not_enabled' ? 403 : 400
      )
    }

    const applyOutcome = await applyIfNewPin(
      c,
      db,
      result,
      {
        hostingId: id,
        organizationId,
        actor: { actorType: 'user', actorId: session.userId },
        editedAt: row.updatedAt,
      },
      applyDeps(c)
    )

    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email ?? null,
      action: 'hosting.letsencrypt.requested',
      targetType: 'hosting',
      targetId: id,
      context: requestAuditContext(result.outcome, www, applyOutcome),
    })

    const [fresh] = await db
      .select({
        id: hosting.id,
        name: hosting.name,
        serviceId: hosting.serviceId,
        tlsId: hosting.tlsId,
        options: hosting.options,
        metadata: hosting.metadata,
        pendingAt: hosting.pendingAt,
        updatedAt: hosting.updatedAt,
      })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!fresh) return c.json({ error: 'Not found' }, 404)
    const certificate = (await loadHostingCertificates(db, organizationId, [fresh], now())).get(id)
    return c.json({
      hosting: fresh,
      certificate: certificate ? { ...certificate, dns: result.dns } : null,
      needsDeploy: pinNeedsDeploy(result.outcome, applyOutcome, certificate?.needsDeploy),
    })
  })

  router.get('/hostings/:id/dns-check', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    if ((await resolveEntityOrganizationId(db, 'hosting', id)) !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }
    const denied = await assertCanOr403(c, 'organization:manage', 'hosting', id)
    if (denied) return denied

    const [row] = await db
      .select({
        id: hosting.id,
        options: hosting.options,
        tlsId: hosting.tlsId,
        metadata: hosting.metadata,
        pendingAt: hosting.pendingAt,
      })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseHostingOptions(row.options)
    const hostnames = options?.hostnames ?? []
    const www = readHostingWwwMode(row.options)
    const refusal = letsEncryptRefusal({
      acmeEnabled: true,
      protocol: resolveHostingProtocol(options),
      bind: resolveHostingBind(options),
      hostnames,
      www,
    })
    if (refusal !== null) {
      return c.json({ error: refusal }, 400)
    }
    const store = createLetsEncryptStore(db)
    const dns = await checkHostingDns({
      hostnames: letsEncryptNames(hostnames, www),
      expectedAddresses: await store.expectedAddresses({ ...row, organizationId }),
      lookup,
      now: now(),
    })
    return c.json({ dns })
  })
}
