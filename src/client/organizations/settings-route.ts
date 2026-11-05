/**
 * The shared shape of the `/organizations/:id/<setting>` routes: open the
 * database, gate on the caller's rights, read the stored `organization.options`,
 * write a change and answer from what was stored.
 *
 * Every step runs the same queries, in the same order, as the hand-written
 * handlers did before, so a route built from these helpers behaves the same.
 */
import { eq, type SQL, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { type AuditAction, recordAudit } from '../../features/audit/audit-records.ts'
import {
  type OrganizationOptions,
  parseOrganizationOptions,
} from '../../features/organizations/organization-options.ts'
import type { OrganizationRouteValidationError } from './routes-helpers.ts'

/** Who may use a settings route: organization managers, or the owner alone. */
export type OrgSettingsGate = 'manage' | 'owner'

export type OrgSettingsScope = { db: Db; id: string }

/** The database and the gated `:id`, or the response that refuses the request. */
export async function openOrgSettingsScope(
  c: Context<AppEnv>,
  gate: OrgSettingsGate
): Promise<OrgSettingsScope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const id = c.req.param('id') ?? ''
  const denied =
    gate === 'owner'
      ? await assertOrgOwnerOr403(c, 'organization', id)
      : await assertCanManageOr403(c, 'organization', id)
  if (denied) return denied
  return { db, id }
}

/** The stored options row, or `undefined` when the organization does not exist. */
export async function loadOrgOptionsRow(
  db: Db,
  id: string
): Promise<{ options: unknown } | undefined> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return row
}

/** Write `options` (an expression over the stored value) and bump `updatedAt`. */
export async function writeOrgOptions(db: Db, id: string, options: SQL): Promise<void> {
  await db
    .update(organization)
    .set({ options, updatedAt: new Date().toISOString() })
    .where(eq(organization.id, id))
}

/** Shallow jsonb merge of `patch` into the stored options. */
export function mergeOrgOptionsSql(patch: Record<string, unknown>): SQL {
  return sql`COALESCE(${organization.options}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`
}

/** The stored options without the top-level `key`. */
export function removeOrgOptionSql(key: string): SQL {
  return sql`COALESCE(${organization.options}, '{}'::jsonb) - ${key}::text`
}

/** Audit a settings change made by the session's user. */
export async function recordOrgSettingAudit(
  c: Context<AppEnv>,
  scope: OrgSettingsScope,
  action: AuditAction,
  context: Record<string, unknown>
): Promise<void> {
  const session = c.get('session')
  await recordAudit(scope.db, {
    organizationId: scope.id,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'organization',
    targetId: scope.id,
    context,
  })
}

/** `GET`: answer from the stored options. */
export function orgOptionsGetRoute(
  gate: OrgSettingsGate,
  respond: (options: OrganizationOptions) => object
) {
  return async (c: Context<AppEnv>) => {
    const scope = await openOrgSettingsScope(c, gate)
    if (scope instanceof Response) return scope
    const row = await loadOrgOptionsRow(scope.db, scope.id)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json(respond(parseOrganizationOptions(row.options)))
  }
}

type AuditEntry = { action: AuditAction; context: Record<string, unknown> }

function auditEntries(entries: AuditEntry | readonly AuditEntry[] | null): readonly AuditEntry[] {
  if (entries === null) return []
  if ('action' in entries) return [entries]
  return entries
}

type ParsedPatch<P> = { ok: true; patch: P } | OrganizationRouteValidationError

/** Gate, read the JSON body and parse it: the shared start of every settings `PUT`. */
async function openOrgSettingsPut<P>(
  c: Context<AppEnv>,
  gate: OrgSettingsGate,
  parse: (body: Record<string, unknown>) => ParsedPatch<P>
): Promise<{ scope: OrgSettingsScope; parsed: { ok: true; patch: P } } | Response> {
  const scope = await openOrgSettingsScope(c, gate)
  if (scope instanceof Response) return scope
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parse(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  return { scope, parsed }
}

/**
 * `PUT` for a setting stored as top-level option keys: parse the body, merge
 * the patch, re-read, optionally audit, answer from what was stored.
 */
export function orgOptionsPatchRoute<P extends Record<string, unknown>>(
  params: Readonly<{
    gate: OrgSettingsGate
    parse: (body: Record<string, unknown>) => ParsedPatch<P>
    respond: (options: OrganizationOptions) => object
    /**
     * The audit rows to write for this change: one entry, several, or null for
     * none (nothing changed). `previous` is the options before the write.
     */
    audit?: (patch: P, previous: OrganizationOptions) => AuditEntry | readonly AuditEntry[] | null
    /** Runs after the options are written (before the audit row). */
    afterWrite?: (db: Db, organizationId: string, patch: P) => Promise<void>
  }>
) {
  return async (c: Context<AppEnv>) => {
    const opened = await openOrgSettingsPut(c, params.gate, params.parse)
    if (opened instanceof Response) return opened
    const { scope, parsed } = opened

    const before = await loadOrgOptionsRow(scope.db, scope.id)
    if (!before) {
      return c.json({ error: 'Not found' }, 404)
    }
    // The write and its follow-up commit together: a failed follow-up (such
    // as erasing stored certificate keys) rolls the setting back too.
    const options = await scope.db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Db
      await writeOrgOptions(tx, scope.id, mergeOrgOptionsSql(parsed.patch))
      await params.afterWrite?.(tx, scope.id, parsed.patch)
      return parseOrganizationOptions((await loadOrgOptionsRow(tx, scope.id))?.options)
    })

    if (params.audit) {
      const entries = params.audit(parsed.patch, parseOrganizationOptions(before.options))
      await Promise.all(
        auditEntries(entries).map(({ action, context }) =>
          recordOrgSettingAudit(c, scope, action, context)
        )
      )
    }
    return c.json(params.respond(options))
  }
}

/** What the TLS settings routes read and write: the organization's Let's Encrypt columns. */
export type OrgTlsSettings = {
  acmeEnabled: boolean
  acmeContactEmail: string | null
  acmeTermsAcceptedAt: string | null
  /** The exact agreement accepted at `acmeTermsAcceptedAt`. */
  acmeTermsUrl: string | null
}

/** Why a TLS settings change was refused, with a machine `code`. */
export type OrgTlsSettingsRefusal = { status: 400 | 409 | 503; error: string; code: string }

/**
 * The organization's TLS settings, or `undefined` when the organization does
 * not exist. `lock` takes the row lock so a check and its write see the same row.
 */
async function loadOrgTlsSettings(
  db: Db,
  id: string,
  lock = false
): Promise<OrgTlsSettings | undefined> {
  const query = db
    .select({
      isAcmeEnabled: organization.isAcmeEnabled,
      acmeContactEmail: organization.acmeContactEmail,
      acmeTermsAcceptedAt: organization.acmeTermsAcceptedAt,
      acmeTermsUrl: organization.acmeTermsUrl,
    })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) return undefined
  return {
    acmeEnabled: row.isAcmeEnabled,
    acmeContactEmail: row.acmeContactEmail,
    // Same ISO form as the time a PUT records, whatever text the driver returns.
    acmeTermsAcceptedAt:
      row.acmeTermsAcceptedAt === null ? null : new Date(row.acmeTermsAcceptedAt).toISOString(),
    acmeTermsUrl: row.acmeTermsUrl,
  }
}

/**
 * `GET` for the TLS settings. `currentTermsUrl` reads the agreement Let's
 * Encrypt names now (null when it cannot be read), so the screen can show it
 * and ask again when it changed.
 */
export function tlsSettingsGetRoute(
  gate: OrgSettingsGate,
  currentTermsUrl: () => Promise<string | null>,
  respond: (settings: OrgTlsSettings, currentTermsUrl: string | null) => object
) {
  return async (c: Context<AppEnv>) => {
    const scope = await openOrgSettingsScope(c, gate)
    if (scope instanceof Response) return scope
    const [settings, terms] = await Promise.all([
      loadOrgTlsSettings(scope.db, scope.id),
      currentTermsUrl(),
    ])
    if (!settings) return c.json({ error: 'Not found' }, 404)
    return c.json(respond(settings, terms))
  }
}

/**
 * `PUT` for the TLS settings. The current agreement is read first, outside the
 * row lock (it may need a request to Let's Encrypt). Then, under the lock,
 * `apply` turns the stored settings and the patch into the new settings or a
 * refusal, and the columns are written. Only the columns hold these
 * settings; nothing is written to `organization.options`.
 */
export function tlsSettingsPutRoute<P>(
  params: Readonly<{
    gate: OrgSettingsGate
    parse: (body: Record<string, unknown>) => ParsedPatch<P>
    currentTermsUrl: () => Promise<string | null>
    apply: (
      before: OrgTlsSettings,
      patch: P,
      now: string,
      currentTermsUrl: string | null
    ) => { ok: true; next: OrgTlsSettings } | { ok: false; refusal: OrgTlsSettingsRefusal }
    respond: (settings: OrgTlsSettings, currentTermsUrl: string | null) => object
    audit: (patch: P, before: OrgTlsSettings, after: OrgTlsSettings) => readonly AuditEntry[]
    /** Runs after the settings are written, in the same transaction. */
    afterWrite: (db: Db, organizationId: string, patch: P) => Promise<void>
  }>
) {
  return async (c: Context<AppEnv>) => {
    const opened = await openOrgSettingsPut(c, params.gate, params.parse)
    if (opened instanceof Response) return opened
    const { scope, parsed } = opened
    const terms = await params.currentTermsUrl()

    const outcome = await scope.db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Db
      const before = await loadOrgTlsSettings(tx, scope.id, true)
      if (!before) return { kind: 'missing' as const }
      const now = new Date().toISOString()
      const applied = params.apply(before, parsed.patch, now, terms)
      if (!applied.ok) return { kind: 'refused' as const, refusal: applied.refusal }
      const { next } = applied
      await tx
        .update(organization)
        .set({
          isAcmeEnabled: next.acmeEnabled,
          acmeContactEmail: next.acmeContactEmail,
          acmeTermsAcceptedAt: next.acmeTermsAcceptedAt,
          acmeTermsUrl: next.acmeTermsUrl,
          updatedAt: now,
        })
        .where(eq(organization.id, scope.id))
      await params.afterWrite(tx, scope.id, parsed.patch)
      return { kind: 'written' as const, before, after: next }
    })

    if (outcome.kind === 'missing') return c.json({ error: 'Not found' }, 404)
    if (outcome.kind === 'refused') {
      const { status, error, code } = outcome.refusal
      return c.json({ error, code }, status)
    }

    await Promise.all(
      params
        .audit(parsed.patch, outcome.before, outcome.after)
        .map(({ action, context }) => recordOrgSettingAudit(c, scope, action, context))
    )
    return c.json(params.respond(outcome.after, terms))
  }
}

/** The stored `deploy_timeout_minutes` (null = default), or `undefined` when the organization does not exist. */
async function loadDeployTimeoutMinutes(db: Db, id: string): Promise<number | null | undefined> {
  const [row] = await db
    .select({ minutes: organization.deployTimeoutMinutes })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return row ? row.minutes : undefined
}

/** `GET` for the deploy time limit, which is a column of its own, not an option key. */
export function deployTimeoutGetRoute(
  gate: OrgSettingsGate,
  respond: (minutes: number | null) => object
) {
  return async (c: Context<AppEnv>) => {
    const scope = await openOrgSettingsScope(c, gate)
    if (scope instanceof Response) return scope
    const minutes = await loadDeployTimeoutMinutes(scope.db, scope.id)
    if (minutes === undefined) return c.json({ error: 'Not found' }, 404)
    return c.json(respond(minutes))
  }
}

/** `PUT` for the deploy time limit: validate, write the column, audit, answer from what was stored. */
export function deployTimeoutPutRoute(
  params: Readonly<{
    gate: OrgSettingsGate
    parse: (body: Record<string, unknown>) => ParsedPatch<{ deployTimeoutMinutes: number }>
    respond: (minutes: number | null) => object
  }>
) {
  return async (c: Context<AppEnv>) => {
    const opened = await openOrgSettingsPut(c, params.gate, params.parse)
    if (opened instanceof Response) return opened
    const { scope, parsed } = opened

    if ((await loadDeployTimeoutMinutes(scope.db, scope.id)) === undefined) {
      return c.json({ error: 'Not found' }, 404)
    }
    await scope.db
      .update(organization)
      .set({
        deployTimeoutMinutes: parsed.patch.deployTimeoutMinutes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, scope.id))
    const stored = await loadDeployTimeoutMinutes(scope.db, scope.id)

    await recordOrgSettingAudit(c, scope, 'organization.deploy_timeout.set', {
      deployTimeoutMinutes: parsed.patch.deployTimeoutMinutes,
    })
    return c.json(params.respond(stored ?? null))
  }
}
