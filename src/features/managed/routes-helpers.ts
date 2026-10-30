import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { getManagedEngineSpec, isManagedEngineCode } from './index.ts'
import type { ManagedSettings } from './settings.ts'
import {
  defaultManagedRelease,
  describeManagedImage,
  effectiveManagedImage,
  isManagedVariantSwapSafe,
  isSameManagedSeries,
  type ManagedReleaseGate,
  resolveManagedImage,
} from './releases.ts'
import type { ManagedConnectionRole } from '../../contracts/commands/schemas.ts'
import {
  managedIngressFamilyForEngine,
  managedIngressPortForEngine,
  resolveManagedIngressPorts,
} from './ingress-ports.ts'
import {
  MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS,
  type ManagedSslMode,
  resolveManagedSslMode,
} from './ssl.ts'
import { organization, server } from '../../db/schema.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import { BadRequestError, parseName, requireStringField } from '../../lib/http/request-fields.ts'

/** Keep aligned with `src/features/principals/store.ts`. */
const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
import { maxTypedNameLength, type PrincipalNameScheme } from '../../lib/principal-name-scheme.ts'
import { LOOPBACK_BIND } from './access-address.ts'
import { loadServerClientAddresses } from '../net/client-addresses.ts'
import {
  clientAddressNeeded,
  type ClientAddressScope,
  clientEndpointsForListener,
} from '../net/client-addresses-pure.ts'
import { loadManagedExternalAccess } from './external-access.ts'
import { resolveStraightThrough, type StraightThroughFacts } from './login-straight-through.ts'
import type { ManagedContext } from './managed-context.ts'
import { type ManagedRowOptions, parseManagedSettings } from './options.ts'
import { evaluateManagedPromoteLagGate } from './promote-lag.ts'
import { isMysqlFamilyEngine, MAX_REPLAY_DELTA_BYTES, parsePgLsn } from './ha-fresh-standby.ts'
import { loadManagedStatusError } from './last-error.ts'
import { listManagedMembers, type ManagedMemberRow } from './members.ts'
import { type ManagedResidualMetadata, serializeManagedRow } from './serialize.ts'
import type { LoginPatchInput } from './login-patch.ts'
import { DATABASE_ADMIN_PRIVILEGE, evaluateDatabaseAdminGrant } from './owner-role.ts'

export {
  DATABASE_ADMIN_PRIVILEGE,
  evaluateDatabaseAdminGrant,
  resolveDatabaseOwnerRole,
} from './owner-role.ts'
import type { DatabaseLoginRole, ManagedLoginRow } from './logins.ts'

export { evaluateManagedPromoteLagGate }

/** One reachable client endpoint on the shared ProxySQL frontend. */
export type ManagedAccessEndpoint = {
  /** `local`: from this server only (127.0.0.1). `external`: from outside the server. */
  reach: 'local' | 'external'
  host: string
  port: number
  /** External only: `Public`, or the name of the datacenter this address is in. */
  label?: string
  /** External only: which side of the server this address is on. */
  scope?: ClientAddressScope
  /** External only: set on a datacenter address. */
  datacenterId?: string | null
  /** External only: this endpoint fills the main connection string. */
  primary?: boolean
}

/**
 * Shared-ProxySQL client listener port for `serverId`.
 *
 * Read from the **server-owner** organization: the listener is configured by
 * whichever org owns the host, which is not necessarily the org of the project
 * asking for the endpoint (grant-placed cross-org projects).
 */
async function resolveListenerPortForServer(
  db: Db,
  params: Readonly<{
    serverId: string
    engineCode: string
    engineDefaultPort: number
  }>
): Promise<number> {
  const [row] = await db
    .select({ organizationOptions: organization.options })
    .from(server)
    .innerJoin(organization, eq(server.organizationId, organization.id))
    .where(eq(server.id, params.serverId))
    .limit(1)
  return managedIngressPortForEngine(
    params.engineCode,
    params.engineDefaultPort,
    resolveManagedIngressPorts(
      parseOrganizationOptions(row?.organizationOptions).managedDatabase?.ports
    )
  )
}

type ManagedAccessParams = Readonly<{
  serverId: string
  engineCode: string
  engineDefaultPort: number
}>

/**
 * Every endpoint the server's shared ProxySQL listens on for this cluster,
 * outside-the-server first, main one first among those.
 *
 * The loopback endpoint is always there: sites run by a site owner's Linux user
 * dial it, and bound containers dial ProxySQL by name over the organization's
 * managed network (see `resolveBindingEndpoint`). External endpoints are there
 * only while the server's "allow external access" setting is on
 * (`./external-access.ts`): one per address clients use that has a host and
 * reaches this engine's port (`features/net/client-addresses.ts`). The setting
 * belongs to the server, so every cluster on it reports the same thing.
 *
 * `addressNeeded` is the "set the address clients use" prompt: external access
 * is on and the panel has nothing it can give out (at most a one-word Linux
 * hostname, which never goes into a connection string).
 */
export async function resolveManagedAccess(
  db: Db,
  params: ManagedAccessParams
): Promise<{
  externalAccess: boolean
  endpoints: ManagedAccessEndpoint[]
  addressNeeded: boolean
}> {
  const { enabled: externalAccess } = await loadManagedExternalAccess(db, params.serverId)
  const port = await resolveListenerPortForServer(db, params)
  const family = managedIngressFamilyForEngine(params.engineCode, params.engineDefaultPort)
  const portKey = family === 'mysql' ? 'mysql' : 'postgres'
  const external = externalAccess
    ? clientEndpointsForListener(
        await loadServerClientAddresses(db, params.serverId),
        portKey,
        port
      )
    : []
  const endpoints: ManagedAccessEndpoint[] = [
    ...external.map((endpoint) => ({
      reach: 'external' as const,
      ...endpoint,
    })),
    { reach: 'local', host: LOOPBACK_BIND, port },
  ]
  return {
    externalAccess,
    endpoints,
    addressNeeded: clientAddressNeeded(externalAccess, external),
  }
}

export async function resolveManagedAccessEndpoints(
  db: Db,
  params: ManagedAccessParams
): Promise<ManagedAccessEndpoint[]> {
  return (await resolveManagedAccess(db, params)).endpoints
}

/**
 * The single endpoint used for the primary DSN: the main outside-the-server
 * one when allowed, else loopback.
 *
 * `null` means "external access is on, but the server has no address to give
 * out" — a real misconfiguration worth surfacing rather than papering over with
 * loopback.
 */
export async function resolveManagedConnectionListener(
  db: Db,
  params: ManagedAccessParams
): Promise<{ host: string; port: number } | null> {
  return connectionListenerFromAccess(await resolveManagedAccess(db, params))
}

/** {@link resolveManagedConnectionListener} from an already resolved access view. */
export function connectionListenerFromAccess(
  access: Readonly<{ externalAccess: boolean; endpoints: readonly ManagedAccessEndpoint[] }>
): { host: string; port: number } | null {
  const primary = access.endpoints[0]!
  if (access.externalAccess && primary.reach !== 'external') return null
  return { host: primary.host, port: primary.port }
}

/** Loopback address on the shared ProxySQL frontend (org overview column). */
export async function resolveManagedLoopbackListener(
  db: Db,
  params: ManagedAccessParams
): Promise<{ host: string; port: number }> {
  const port = await resolveListenerPortForServer(db, params)
  return { host: LOOPBACK_BIND, port }
}

/**
 * Args for {@link resolveManagedConnectionListener} on GET …/managed/status.
 *
 * Returns null when the cluster is unplaced, uncatalogued, or has unreadable
 * options — the status route then falls back to residual `host`/`port`.
 */
export function managedStatusListenerParams(
  row: {
    serverId: string | null
    engine: string | null
    options: unknown
  } | null
): {
  serverId: string
  engineCode: string
  engineDefaultPort: number
} | null {
  if (!row?.serverId) return null
  if (!row.engine || !isManagedEngineCode(row.engine)) return null
  const spec = getManagedEngineSpec(row.engine)
  if (!spec) return null
  if (parseManagedSettings(spec, row.options) === null) return null
  return {
    serverId: row.serverId,
    engineCode: spec.engine,
    engineDefaultPort: spec.defaultPort,
  }
}

type ManagedStatusContextRow = {
  id: string
  status: string | null
  serverId: string | null
  engine: string | null
  options: unknown
}

/** Members, failure text, and listener for GET …/managed/status. */
export async function loadManagedStatusSnapshot(
  db: Db,
  row: ManagedStatusContextRow | null,
  residual: ManagedResidualMetadata
): Promise<{
  memberRows: ManagedMemberRow[]
  lastError: string | null
  listener: Awaited<ReturnType<typeof resolveManagedConnectionListener>>
}> {
  if (!row) {
    return { memberRows: [], lastError: null, listener: null }
  }

  const memberRows = await listManagedMembers(db, row.id)
  const lastError = await loadManagedStatusError(db, {
    managedId: row.id,
    status: row.status,
    residualError: residual.error ?? null,
    serverIds: [row.serverId, ...memberRows.map((entry) => entry.serverId)],
  })
  const listenerParams = managedStatusListenerParams(row)
  const listener = listenerParams
    ? await resolveManagedConnectionListener(db, listenerParams)
    : null
  return { memberRows, lastError, listener }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function managedSessionPaths(): string[] {
  return [
    '/environments/:id/managed',
    '/environments/:id/managed/apply',
    '/environments/:id/managed/lifecycle',
    '/environments/:id/managed/root-password',
    '/environments/:id/managed/users',
    '/environments/:id/managed/users/:loginId',
    '/environments/:id/managed/users/:loginId/password',
    '/environments/:id/managed/users/:loginId/effective-permissions',
    '/environments/:id/managed/backup-login',
    '/environments/:id/managed/databases',
    '/environments/:id/managed/databases/:databaseName',
    '/environments/:id/managed/databases/:databaseName/owner-role',
    '/environments/:id/managed/databases/:databaseName/app-logins',
    '/environments/:id/managed/privilege-catalogue',
    '/environments/:id/managed/status',
    '/environments/:id/managed/logs',
    '/environments/:id/managed/backups',
    '/environments/:id/managed/backups/:backupId',
    '/environments/:id/managed/backups/:backupId/restore',
    '/environments/:id/managed/backup-policies',
    '/environments/:id/managed/backup-policies/:policyId',
    '/environments/:id/managed/backup-policies/:policyId/runs',
    '/environments/:id/managed/backup-target',
    '/environments/:id/managed/members',
    '/environments/:id/managed/members/:memberId',
    '/environments/:id/managed/members/:memberId/promote',
    '/environments/:id/managed/members/:memberId/resync',
    '/environments/:id/managed/disaster-recovery/promote',
    '/organizations/:id/managed',
    '/servers/:id/managed-external-access',
  ]
}

export function mergeCreateSettings(
  spec: {
    defaultSettings: ManagedSettings
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  /** Resolved catalog image from {@link parseManagedVersionSelection}. */
  image?: string
): ManagedSettings | null {
  const base = spec.parseSettings(spec.defaultSettings)
  if (!base) return null

  const overrides: Record<string, unknown> = {}
  if (image !== undefined) overrides.image = image

  if (Object.keys(overrides).length === 0) return base
  return spec.parseSettings({ ...base, ...overrides })
}

/** Requested engine series or image variant is not in the release catalog. */
export const MANAGED_VERSION_UNSUPPORTED_ERROR = 'managed_version_unsupported'

/** A cluster's engine series cannot change after create. */
export const MANAGED_SERIES_IMMUTABLE_ERROR = 'managed_series_immutable'

/** A PostgreSQL image swap between libc families would corrupt text indexes. */
export const MANAGED_VARIANT_SWAP_UNSAFE_ERROR = 'managed_variant_swap_unsafe'

/**
 * Resolve create-time `engineSeries` / `imageVariant` to a catalog image.
 *
 * Both fields are optional — omitting them keeps the engine spec's default
 * image, which is how every existing client creates a cluster. `imageVariant`
 * alone selects that variant of the default series. An unknown series or
 * variant is a **422** rather than a generic settings rejection so the UI can
 * say which version was refused (an EOL, never-supported, or merely untested
 * major must not be creatable).
 *
 * Only **tested** series resolve. `gate.includeUntested` is the one explicit
 * opt-in — the catalog's own suites use it to prove an untested series is
 * refused by default rather than absent from the catalog.
 */
export function parseManagedVersionSelection(
  engine: string,
  body: Record<string, unknown>,
  gate?: ManagedReleaseGate
):
  | { ok: true; image?: string }
  | {
      ok: false
      error: string
      status: 400 | 422
    } {
  const seriesRaw = body.engineSeries
  const variantRaw = body.imageVariant
  if (seriesRaw === undefined && variantRaw === undefined) return { ok: true }

  if (seriesRaw !== undefined && typeof seriesRaw !== 'string') {
    return { ok: false, error: 'Invalid engineSeries', status: 400 }
  }
  if (variantRaw !== undefined && typeof variantRaw !== 'string') {
    return { ok: false, error: 'Invalid imageVariant', status: 400 }
  }

  const series = seriesRaw ?? defaultManagedRelease(engine, gate)?.series
  if (series === undefined) {
    return { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 }
  }

  const image = resolveManagedImage(engine, series, variantRaw, gate)
  if (image === undefined) {
    return { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 }
  }
  return { ok: true, image }
}

/** A settings patch is refused with HTTP 409, an error code and plain words. */
export type ManagedImageRefusal = {
  ok: false
  error: string
  message: string
  status: 409
}

/**
 * Refuse a settings patch that moves an existing cluster to another engine
 * series.
 *
 * An engine refuses to start on a data directory written by a different major,
 * and cross-major replication is not a supported topology, so an in-place
 * series change would break the cluster rather than upgrade it. Series
 * migration is a separate managed service plus a data move, not a settings
 * edit. Whether a base-OS variant may change is decided by
 * {@link assertManagedVariantSwapSafe}.
 */
export function assertManagedSeriesUnchanged(
  spec: { defaultImage: string; legacyDefaultImage?: string },
  currentSettings: ManagedSettings,
  nextSettings: ManagedSettings
): ManagedImageRefusal | null {
  const current = effectiveManagedImage(spec, currentSettings.image)
  const next = effectiveManagedImage(spec, nextSettings.image)
  if (isSameManagedSeries(current, next)) return null
  return {
    ok: false,
    error: MANAGED_SERIES_IMMUTABLE_ERROR,
    message:
      'The database version cannot be changed on an existing cluster, because the data ' +
      'on disk only works with the version that wrote it. Create a new cluster on the ' +
      'version you want and restore a backup into it.',
    status: 409,
  }
}

/**
 * Refuse a settings patch that swaps a PostgreSQL cluster between the Alpine
 * and Debian images.
 *
 * The two images use different C libraries, which sort text differently, so
 * every text index would silently become wrong (proven on a test host:
 * `bt_index_check` fails and index-ordered queries return a different order).
 * Same-variant changes, no-op patches, and engines with their own collations
 * (MySQL, MariaDB) pass. The policy lives in {@link isManagedVariantSwapSafe}.
 */
export function assertManagedVariantSwapSafe(
  spec: { defaultImage: string; legacyDefaultImage?: string },
  currentSettings: ManagedSettings,
  nextSettings: ManagedSettings
): ManagedImageRefusal | null {
  const current = effectiveManagedImage(spec, currentSettings.image)
  const next = effectiveManagedImage(spec, nextSettings.image)
  if (isManagedVariantSwapSafe(current, next)) return null
  return {
    ok: false,
    error: MANAGED_VARIANT_SWAP_UNSAFE_ERROR,
    message:
      'Switching this PostgreSQL cluster between the Alpine and Debian images would ' +
      'silently break its text indexes, because the two sort text differently and the ' +
      'data would need re-indexing. Create a new cluster on the image you want and ' +
      'restore a backup into it.',
    status: 409,
  }
}

/** Run the series guard, then the variant guard; first refusal wins. */
export function assertManagedImageChangeAllowed(
  spec: { defaultImage: string; legacyDefaultImage?: string },
  currentSettings: ManagedSettings,
  nextSettings: ManagedSettings
): ManagedImageRefusal | null {
  return (
    assertManagedSeriesUnchanged(spec, currentSettings, nextSettings) ??
    assertManagedVariantSwapSafe(spec, currentSettings, nextSettings)
  )
}

export function readInitialDatabase(spec: {
  parseSettings: (v: unknown) => ManagedSettings | null
  defaultSettings: ManagedSettings
}): string {
  const parsed = spec.parseSettings(spec.defaultSettings)
  if (parsed && typeof parsed === 'object' && 'initialDatabase' in parsed) {
    const initial = (parsed as Record<string, unknown>).initialDatabase
    if (typeof initial === 'string' && initial.length > 0) {
      return initial
    }
  }
  return 'defaultdb'
}

/**
 * Display-only server id for serialization/read paths — returns `null` when
 * neither `managed.server_id` nor the environment's placement is known.
 */
export function resolveManagedServerId(
  managedRow: { serverId: string | null },
  fallbackServerId: string | null
): string | null {
  return managedRow.serverId ?? fallbackServerId
}

/**
 * The API fields for connecting straight through: `straightThrough` is what
 * the front door will do (false with a source limit), and
 * `straightThroughDefault` is true when that comes from the default rather
 * than a choice, so the UI can show 'default'.
 */
export function straightThroughFields(facts: StraightThroughFacts) {
  const resolved = resolveStraightThrough(facts)
  return { straightThrough: resolved.value, straightThroughDefault: resolved.isDefault }
}

/**
 * A login in the managed users API shape. `id` is the login id (what the
 * users routes are addressed by); `loginId` repeats it, and `principalId` is
 * the site owner's Linux user the login shares its name with, or `null`.
 */
export function serializeManagedLogin(row: ManagedLoginRow, engine: string) {
  return {
    id: row.id,
    username: row.username,
    appliedUsername: row.appliedUsername,
    nameScheme: row.nameScheme,
    databases: row.databases,
    privileges: row.privileges,
    connectionRole: row.connectionRole,
    grantMode: row.grantMode,
    tool: row.tool,
    // 'any' when unrestricted; otherwise the places the login may connect from.
    allowedSources: row.allowedSources ?? ['any'],
    maxConnections: row.maxConnections ?? null,
    ...straightThroughFields({ ...row, engine }),
    createdAt: row.createdAt,
    principalId: row.principalId,
    loginId: row.id,
  }
}

export function serializeContainerRow(row: {
  id: string
  serviceId: string
  serverId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serverId: row.serverId,
    containerId: row.containerId,
    containerName: row.containerName,
    status: row.status,
    role: row.role,
    composeServiceName: row.composeServiceName,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Login names reserved for platform-internal engine accounts: the engines'
 * real bootstrap/socket admins (`postgres`, `root`, `mysql`) and the
 * `superadmin` name held back for turbopanel internals. The exposed
 * administrative login is always the suffixed `postgres_<11 rand>`/`root_<11 rand>`
 * principal, so these bare names must never become client logins.
 */
const RESERVED_MANAGED_USERNAMES = new Set(['postgres', 'root', 'mysql', 'superadmin'])

/**
 * The `tp_` prefix belongs to the platform: the roles of a database's owner
 * role (`tp_<db>_owner`, `_rw`, `_ro`), the monitor login (`tp_monitor_…`) and
 * the replication login (`tp_repl`). No client login may take a name with it.
 */
const RESERVED_MANAGED_USERNAME_PREFIX = 'tp_'

/** PostgreSQL itself owns role names starting with `pg_`. */
const RESERVED_POSTGRES_NAME_PREFIX = 'pg_'

export function isReservedManagedUsername(
  username: string,
  rootUsername?: string,
  engine?: string
): boolean {
  const lower = username.toLowerCase()
  return (
    RESERVED_MANAGED_USERNAMES.has(lower) ||
    lower.startsWith(RESERVED_MANAGED_USERNAME_PREFIX) ||
    (engine === 'postgres' && lower.startsWith(RESERVED_POSTGRES_NAME_PREFIX)) ||
    (rootUsername !== undefined && username === rootUsername)
  )
}

export function parseManagedUserCreateFields(
  c: Context,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions,
  /** Persisted cluster root username when known; falls back to spec preference. */
  rootUsername?: string,
  /**
   * Scheme the applied login will use. `partial` adds a `_<11>` suffix, so
   * the typed name must leave room for it within the engine's identifier
   * maxLength; `plain` and `random` use the full length for the typed name.
   */
  nameScheme: PrincipalNameScheme = 'plain'
):
  | {
      username: string
      databases: string[]
      privileges: string[]
      connectionRole: ManagedConnectionRole
    }
  | Response {
  const username = requireStringField(c, body, 'username')
  if (username instanceof Response) return username
  const nameError = checkManagedLoginName(c, ctx, username, rootUsername, nameScheme)
  if (nameError) return nameError

  const grants = parseManagedLoginGrantFields(c, ctx, body, options)
  if (grants instanceof Response) return grants
  return { username, ...grants }
}

/**
 * A typed login name the engine accepts under `nameScheme` and that is not a
 * reserved name: `null` when fine, else the 400/422 answer.
 */
export function checkManagedLoginName(
  c: Context,
  ctx: ManagedContext,
  username: string,
  rootUsername: string | undefined,
  nameScheme: PrincipalNameScheme
): Response | null {
  const effectiveRoot = rootUsername ?? ctx.spec.rootUsername
  const { pattern, maxLength } = ctx.spec.userOperations.identifier
  const maxShortLength = maxTypedNameLength(nameScheme, maxLength)
  if (!USERNAME_RE.test(username) || !pattern.test(username) || username.length > maxShortLength) {
    return c.json({ error: 'Invalid username' }, 400)
  }
  if (isReservedManagedUsername(username, effectiveRoot, ctx.spec.engine)) {
    return c.json(
      {
        error: 'reserved_username',
        message: `'${username}' is a name the database engine or TurboPanel keeps for itself. Pick a different login name.`,
      },
      422
    )
  }
  return null
}

/**
 * What a login may do, independent of its name: the databases it is granted
 * on, its connection role and its privileges. Shared by a login with a new
 * name and a login created for an existing principal.
 */
export function parseManagedLoginGrantFields(
  c: Context,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions
):
  | {
      databases: string[]
      privileges: string[]
      connectionRole: ManagedConnectionRole
    }
  | Response {
  if (!Array.isArray(body.databases) || body.databases.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const databases = body.databases.filter((entry): entry is string => typeof entry === 'string')
  if (
    databases.length === 0 ||
    databases.length !== body.databases.length ||
    !databases.every((name) => options.databases.includes(name))
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  // A cluster that predates the reserved-name check may still list a system schema.
  if (databases.some((name) => isReservedDatabaseName(ctx.spec.engine, name))) {
    return c.json(reservedDatabaseNameBody(), 422)
  }

  const connectionRole = parseManagedConnectionRole(body.connectionRole)
  if (connectionRole === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const privileges = resolveManagedUserPrivileges(
    body.privileges,
    ctx.spec.userOperations.privileges,
    connectionRole
  )
  if (privileges === null) {
    return c.json(
      {
        error: MANAGED_USER_PRIVILEGES_INVALID_ERROR,
        message: `privileges must list at least one of: ${ctx.spec.userOperations.privileges.join(
          ', '
        )}. Leave it out to get the default for the login's connection role.`,
      },
      400
    )
  }

  const admin = evaluateDatabaseAdminGrant(ctx.spec.engine, {
    privileges,
    connectionRole,
  })
  if (admin) {
    return c.json({ error: admin.error, message: admin.message }, admin.status)
  }

  return {
    databases,
    privileges: privileges.includes(DATABASE_ADMIN_PRIVILEGE)
      ? [DATABASE_ADMIN_PRIVILEGE]
      : privileges,
    connectionRole,
  }
}

/**
 * Whether an existing principal's applied name can be this engine's role
 * name as-is (a login for a principal never renames). `null` when it fits.
 */
export function evaluateExistingPrincipalLoginName(
  spec: ManagedContext['spec'],
  appliedUsername: string,
  rootUsername?: string
): { error: string; message: string } | null {
  const { pattern, maxLength } = spec.userOperations.identifier
  if (!pattern.test(appliedUsername) || appliedUsername.length > maxLength) {
    return {
      error: 'principal_name_does_not_fit',
      message: `The principal's name '${appliedUsername}' is not a valid ${spec.engine} role name (at most ${maxLength} characters, matching ${pattern}). Create a login with a new name instead.`,
    }
  }
  if (isReservedManagedUsername(appliedUsername, rootUsername ?? spec.rootUsername, spec.engine)) {
    return {
      error: 'principal_name_reserved',
      message: `The principal's name '${appliedUsername}' is reserved on ${spec.engine}. Create a login with a new name instead.`,
    }
  }
  return null
}

/**
 * Grant mode and tool flag for a new login. A new login defaults to
 * `recipe`; `preset` is not accepted for new logins. Plain-words 400 otherwise.
 */
export function parseManagedLoginModeFields(
  c: Context,
  body: Record<string, unknown>,
  /** A Database admin login is a tool login unless the request says otherwise. */
  toolByDefault = false
): { grantMode: 'recipe' | 'self'; tool: boolean } | Response {
  const mode = body.grantMode ?? 'recipe'
  if (mode !== 'recipe' && mode !== 'self') {
    return c.json(
      {
        error: 'managed_grant_mode_invalid',
        message:
          "grantMode must be 'recipe' (the panel sets permissions) or 'self' (you set them).",
      },
      400
    )
  }
  if (body.tool !== undefined && typeof body.tool !== 'boolean') {
    return c.json(
      {
        error: 'Invalid request',
        message: 'tool must be true or false.',
      },
      400
    )
  }
  return {
    grantMode: mode,
    tool: body.tool === undefined ? toolByDefault : body.tool === true,
  }
}

/** Fields of a PATCH on a login; everything is optional, validated on its own. */
export function parseManagedLoginPatchFields(
  c: Context,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions
): (LoginPatchInput & { dryRun: boolean }) | Response {
  const input: LoginPatchInput & { dryRun: boolean } = {
    dryRun: body.dryRun === true,
    grantMode: body.grantMode,
    tool: body.tool,
    confirmReset: body.confirmReset,
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return c.json(
      {
        error: 'Invalid request',
        message: 'dryRun must be true or false.',
      },
      400
    )
  }
  if (body.databases !== undefined) {
    const list = body.databases
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((name) => typeof name === 'string' && options.databases.includes(name))
    ) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (list.some((name) => isReservedDatabaseName(ctx.spec.engine, name))) {
      return c.json(reservedDatabaseNameBody(), 422)
    }
    input.databases = [...new Set(list as string[])]
  }
  if (body.connectionRole !== undefined) {
    if (body.connectionRole !== 'read-write' && body.connectionRole !== 'read-only') {
      return c.json({ error: 'Invalid request' }, 400)
    }
    input.connectionRole = body.connectionRole
  }
  if (body.privileges !== undefined) {
    const privileges = resolveManagedUserPrivileges(
      body.privileges,
      ctx.spec.userOperations.privileges,
      input.connectionRole ?? 'read-write'
    )
    if (privileges === null) {
      return c.json(
        {
          error: MANAGED_USER_PRIVILEGES_INVALID_ERROR,
          message: `privileges must list at least one of: ${ctx.spec.userOperations.privileges.join(
            ', '
          )}.`,
        },
        400
      )
    }
    input.privileges = privileges
  }
  return input
}

/** `privileges` was present but empty, unknown, or not a list of names. */
export const MANAGED_USER_PRIVILEGES_INVALID_ERROR = 'managed_user_privileges_invalid'

/**
 * Privileges for a new login: what was asked for, or - when the request leaves
 * `privileges` out - the grant that matches the login's connection role
 * (`read-only` for a read-only login, `read-write` otherwise). A login created
 * with no grants can connect but is refused everywhere, so "none" is never a
 * valid answer: an explicit empty list, an unknown name or a non-list is `null`.
 */
export function resolveManagedUserPrivileges(
  requested: unknown,
  allowed: readonly string[],
  connectionRole: ManagedConnectionRole
): string[] | null {
  if (requested === undefined || requested === null) {
    return [connectionRole === 'read-only' ? 'read-only' : 'read-write']
  }
  if (!Array.isArray(requested) || requested.length === 0) return null
  const names = requested.filter((entry): entry is string => typeof entry === 'string')
  if (names.length !== requested.length) return null
  return names.every((name) => allowed.includes(name)) ? [...new Set(names)] : null
}

/**
 * Frontend hostgroup a login defaults to. Absent means `read-write` — the
 * historical behavior and the only safe default, since a `read-only` login is
 * useless when the cluster has no read-eligible replica, so the daemon
 * routes it to the primary there.
 */
export function parseManagedConnectionRole(value: unknown): ManagedConnectionRole | null {
  if (value === undefined || value === null) return 'read-write'
  if (value === 'read-write' || value === 'read-only') return value
  return null
}

export type ManagedRouteValidationError = {
  ok: false
  error: string
  /** Plain-words explanation shown next to the error code, when one helps. */
  message?: string
  status: 400 | 409 | 422
}

export type ManagedLifecycleAction = 'start' | 'stop' | 'restart'

export function parseManagedLifecycleAction(
  body: Record<string, unknown>
): { ok: true; action: ManagedLifecycleAction } | ManagedRouteValidationError {
  const action = body.action
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, action }
}

/**
 * Name parse for managed create — mirrors {@link parseName}
 * but returns a typed validation error instead of throwing.
 */
export function parseManagedCreateName(
  body: Record<string, unknown>
): { ok: true; name: string | null } | ManagedRouteValidationError {
  try {
    return { ok: true, name: parseName(body) }
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    throw error
  }
}

/**
 * Name parse for managed PATCH. Absent leaves the name alone (`name: undefined`),
 * `null` clears it, a string is validated like the create name. The name is only
 * a label: nothing on a host is derived from it.
 */
export function parseManagedPatchName(
  body: Record<string, unknown>
): { ok: true; name: string | null | undefined } | ManagedRouteValidationError {
  if (body.name === undefined) return { ok: true, name: undefined }
  if (body.name === null) return { ok: true, name: null }
  return parseManagedCreateName(body)
}

/**
 * Merge PATCH `settings` onto current managed settings and re-validate via
 * the engine spec. Returns `null` when the merged shape is invalid.
 */
export function mergeManagedPatchSettings(
  spec: {
    parseSettings: (v: unknown) => ManagedSettings | null
  },
  currentSettings: ManagedSettings,
  body: Record<string, unknown>
): ManagedSettings | null {
  return spec.parseSettings({
    ...currentSettings,
    ...(isPlainObject(body.settings) ? body.settings : {}),
  })
}

/**
 * Engine system schemas that must never be created or granted as an application
 * database. A user granted `mysql.*` (or `sys.*`) can read and write the
 * engine's own account and configuration tables, so the name is refused the same
 * way the initial database is. Matched case-insensitively, as the engines
 * themselves treat these names.
 */
const MYSQL_FAMILY_RESERVED_DATABASES: readonly string[] = [
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
]

export function reservedDatabaseNames(engine: string): readonly string[] {
  return engine === 'mysql' || engine === 'mariadb' ? MYSQL_FAMILY_RESERVED_DATABASES : []
}

export function isReservedDatabaseName(engine: string, name: string): boolean {
  return reservedDatabaseNames(engine).includes(name.toLowerCase())
}

/**
 * PostgreSQL's built-in databases and the `pg_` prefix it keeps. Only checked
 * when a database is created: older clusters may already list `postgres` as an
 * ordinary database and keep working.
 */
const POSTGRES_RESERVED_NEW_DATABASES: ReadonlySet<string> = new Set([
  'postgres',
  'template0',
  'template1',
])

/** The plain answer for a reserved database name (HTTP 422). */
function reservedDatabaseNameBody(name?: string): { error: string; message: string } {
  const subject = name === undefined ? 'That database name' : `'${name}'`
  return {
    error: 'reserved_database_name',
    message: `${subject} is a name the database engine keeps for itself. Pick a different database name.`,
  }
}

/** True for a name that must not be given to a new database or initial database. */
export function isReservedNewDatabaseName(engine: string, name: string): boolean {
  if (isReservedDatabaseName(engine, name)) return true
  if (engine !== 'postgres') return false
  const lower = name.toLowerCase()
  return (
    POSTGRES_RESERVED_NEW_DATABASES.has(lower) || lower.startsWith(RESERVED_POSTGRES_NAME_PREFIX)
  )
}

export function validateManagedDatabaseCreateName(
  name: string,
  databases: readonly string[],
  identifier: { pattern: RegExp; maxLength: number },
  engine = ''
): ManagedRouteValidationError | null {
  if (!identifier.pattern.test(name) || name.length > identifier.maxLength) {
    return {
      ok: false,
      error: 'Invalid database name',
      message: `A database name may use letters, digits and underscores only, must start with a letter or underscore, and can be at most ${identifier.maxLength} characters. Hyphens are not allowed on purpose: use an underscore instead (my_app, not my-app).`,
      status: 400,
    }
  }
  if (isReservedNewDatabaseName(engine, name)) {
    return { ok: false, ...reservedDatabaseNameBody(name), status: 422 }
  }
  if (databases.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'database_exists', status: 409 }
  }
  return null
}

/** Narrow the false status union — delete-not-found uses HTTP 404. */
export type ManagedDatabaseDeleteError =
  | { ok: false; error: 'Not found'; status: 404 }
  | { ok: false; error: 'cannot_drop_initial_database'; status: 409 }

export function evaluateManagedDatabaseDelete(
  databaseName: string,
  databases: readonly string[],
  initialDatabase: string
): ManagedDatabaseDeleteError | null {
  if (!databases.includes(databaseName)) {
    return { ok: false, error: 'Not found', status: 404 }
  }
  if (databaseName === initialDatabase) {
    return { ok: false, error: 'cannot_drop_initial_database', status: 409 }
  }
  return null
}

/**
 * Typed usernames of the SQL users (never the root or replication login)
 * whose `databases` list still names `databaseName`. Dropping the database
 * while any remain would leave the next apply granting on a missing database.
 */
export function listUsersReferencingDatabase(
  logins: ReadonlyArray<{ username: string; role: string; databases: readonly string[] }>,
  databaseName: string
): string[] {
  return logins
    .filter((entry) => entry.role === 'user' && entry.databases.includes(databaseName))
    .map((entry) => entry.username)
}

export function nextDatabasesAfterCreate(databases: readonly string[], name: string): string[] {
  return [...databases, name].sort((a, b) => a.localeCompare(b))
}

export function nextDatabasesAfterDelete(
  databases: readonly string[],
  databaseName: string
): string[] {
  return databases.filter((entry) => entry !== databaseName)
}

export function parsePromoteForce(body: Record<string, unknown>): boolean {
  return body.force === true
}

export function parseDisasterRecoveryPromoteBody(body: Record<string, unknown>):
  | { ok: true; memberId: string }
  | {
      ok: false
      error: 'Invalid request'
      status: 400
    } {
  if (body.confirm !== true) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (typeof body.memberId !== 'string' || body.memberId.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, memberId: body.memberId }
}

export function parseMemberReadEligibleCreate(body: Record<string, unknown>): boolean {
  return body.readEligible === true
}

export function parseReplicaClassCreate(
  body: Record<string, unknown>
): { ok: true; replicaClass: 'failover' | 'read' } | ManagedRouteValidationError {
  if (body.replicaClass === undefined) {
    return { ok: true, replicaClass: 'failover' }
  }
  if (body.replicaClass === 'failover' || body.replicaClass === 'read') {
    return { ok: true, replicaClass: body.replicaClass }
  }
  return { ok: false, error: 'Invalid request', status: 400 }
}

export function parseMemberReadEligiblePatch(
  body: Record<string, unknown>
): { ok: true; readEligible: boolean } | ManagedRouteValidationError {
  if (typeof body.readEligible !== 'boolean') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return { ok: true, readEligible: body.readEligible }
}

export type MemberPatchFields = {
  readEligible?: boolean
  replicaClass?: 'failover' | 'read'
}

export function parseMemberPatch(
  body: Record<string, unknown>
): ({ ok: true } & MemberPatchFields) | ManagedRouteValidationError {
  const hasReadEligible = Object.hasOwn(body, 'readEligible')
  const hasReplicaClass = Object.hasOwn(body, 'replicaClass')
  if (!hasReadEligible && !hasReplicaClass) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const patch: { ok: true } & MemberPatchFields = { ok: true }
  if (hasReadEligible) {
    if (typeof body.readEligible !== 'boolean') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.readEligible = body.readEligible
  }
  if (hasReplicaClass) {
    if (body.replicaClass !== 'failover' && body.replicaClass !== 'read') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    patch.replicaClass = body.replicaClass
  }
  return patch
}

/**
 * Hard-delete is safe only when the cluster has no placement pin — there is
 * no host runtime to tear down. Stopped / failed / provisioning clusters can
 * still have Docker containers (lifecycle stop is non-destructive; apply may
 * have brought the engine up before failing).
 */
export function canHardDeleteManaged(serverId: string | null | undefined): boolean {
  return !serverId
}

export type ReplicaPlacementPrecheckError = {
  ok: false
  error: 'managed_member_exists'
  status: 409
}

/**
 * Pure prechecks before datacenter / private-endpoint / online probes.
 */
export function evaluateReplicaPlacementPrechecks(
  members: ReadonlyArray<{ serverId: string; role: string }>,
  serverId: string
): ReplicaPlacementPrecheckError | null {
  if (members.some((m) => m.serverId === serverId)) {
    return { ok: false, error: 'managed_member_exists', status: 409 }
  }
  return null
}

export function replicaEndpointPurpose(
  replicaClass: 'failover' | 'read'
): 'failover-replication' | 'read-replication' {
  return replicaClass === 'read' ? 'read-replication' : 'failover-replication'
}

export type FailoverReplicaTransportError = {
  kind: 'failover_replica_requires_datacenter_transport'
}

/**
 * Failover replicas may use local, datacenter or fabric transport — never
 * public. The resolver only returns fabric for a pair that shares untrusted
 * datacenters, and answers `untrusted_network_needs_fabric` when the tunnel
 * cannot carry the traffic, so a `datacenter` transport reaching this check
 * is always trusted-derived.
 */
export function assertFailoverReplicaTransportAllowed(
  transport: 'local' | 'datacenter' | 'fabric' | 'public'
): FailoverReplicaTransportError | null {
  if (transport === 'public') {
    return { kind: 'failover_replica_requires_datacenter_transport' }
  }
  return null
}

/**
 * Whether placement still needs a ready datacenter CIDR after transport resolve.
 * Failover needs a datacenter unless it rides fabric (an untrusted-only pair;
 * public is rejected earlier). Read replicas skip the CIDR check on
 * fabric/public (already overlay/TLS).
 */
/**
 * A new placement (replica create, class change) never lands on a path that
 * fell to the public address on an untrusted network or on a tunnel with no
 * recent handshake: TurboFabric has to carry it. Running traffic is untouched.
 */
export function placementNeedsHealthyFabric(
  resolved: Readonly<{ untrustedPublic?: true; tunnelDown?: true }>
): boolean {
  return resolved.untrustedPublic === true || resolved.tunnelDown === true
}

export function replicaPlacementNeedsDatacenter(
  transport: 'local' | 'datacenter' | 'fabric' | 'public',
  replicaClass: 'failover' | 'read'
): boolean {
  if (replicaClass === 'failover') {
    return transport !== 'fabric'
  }
  return transport !== 'fabric' && transport !== 'public'
}

export function evaluatePromoteMemberRole(role: string): ManagedRouteValidationError | null {
  if (role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return null
}

export function evaluatePromoteReplicaClass(
  replicaClass: string | null
): { ok: false; error: 'managed_replica_not_promotable'; status: 422 } | null {
  if (replicaClass !== 'failover') {
    return { ok: false, error: 'managed_replica_not_promotable', status: 422 }
  }
  return null
}

export type ReplicaClassConversionError =
  | { ok: false; error: 'Invalid request'; status: 400 }
  | {
      ok: false
      error: 'failover_replica_requires_datacenter_transport'
      status: 422
    }

/**
 * Class conversion: failover → read always allowed; read → failover requires
 * shared-datacenter placement to already have succeeded.
 */
export function evaluateReplicaClassConversion(
  member: Readonly<{ role: string; replicaClass: string | null }>,
  targetClass: 'failover' | 'read',
  placementOk: boolean
): ReplicaClassConversionError | null {
  if (member.role !== 'replica') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (targetClass === 'read') return null
  if (!placementOk) {
    return {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    }
  }
  return null
}

export type ManagedUserRotateGuardError =
  | { ok: false; error: 'use_root_password_route'; status: 400 }
  | { ok: false; error: 'cannot_rotate_replication_user'; status: 400 }

/** The cluster's own logins rotate elsewhere (root) or never (replication). */
export function evaluateManagedLoginRotateGuard(
  role: DatabaseLoginRole
): ManagedUserRotateGuardError | null {
  if (role === 'root') {
    return { ok: false, error: 'use_root_password_route', status: 400 }
  }
  if (role === 'replication') {
    return { ok: false, error: 'cannot_rotate_replication_user', status: 400 }
  }
  return null
}

export function evaluateManagedLoginDropGuard(
  role: DatabaseLoginRole
): { ok: false; error: 'cannot_drop_root_user'; status: 400 } | null {
  if (role === 'root') {
    return { ok: false, error: 'cannot_drop_root_user', status: 400 }
  }
  return null
}

/**
 * Promote lag gate for HTTP — `force` bypasses. Returns the 409 error code
 * when blocked, else `null`.
 */
export function evaluatePromoteLagHttpGate(
  replication: unknown,
  force: boolean,
  nowMs?: number
):
  | null
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale'
  | 'managed_replica_not_fully_applied' {
  if (force) return null
  return evaluateManagedPromoteLagGate(replication, nowMs)
}

/**
 * Oldest replica reading an operator (non-force) promote will act on after a
 * live `managed-health-request` answer. A stored reading from before the last
 * few seconds proves nothing (a replication thread that stopped a moment ago
 * still looks `streaming` in an older one).
 */
export const OPERATOR_PROMOTE_MAX_OBSERVATION_AGE_MS = 15_000

/** Operator promote when the replica daemon did not return a live health probe. */
export const MANAGED_REPLICA_LIVE_CHECK_FAILED = 'managed_replica_live_check_failed'

export const MANAGED_REPLICA_LIVE_CHECK_FAILED_MESSAGE =
  'The replica did not answer a live check, so it cannot be proven caught up. Try again, or force the promote if you accept possible data loss.'

export function buildManagedReplicaLiveCheckFailedBody(): {
  error: typeof MANAGED_REPLICA_LIVE_CHECK_FAILED
  message: string
} {
  return {
    error: MANAGED_REPLICA_LIVE_CHECK_FAILED,
    message: MANAGED_REPLICA_LIVE_CHECK_FAILED_MESSAGE,
  }
}

/**
 * Gate for the operator promote route: {@link evaluatePromoteLagHttpGate} on
 * a tight reading age, plus engine-specific proof the replica applied what it
 * received (MySQL/MariaDB: `fullyApplied === true`; Postgres: received LSN
 * replayed within {@link MAX_REPLAY_DELTA_BYTES}). `force` bypasses both, as
 * before. Automatic failover keeps its own probe and thresholds.
 */
export function evaluateOperatorPromoteGate(
  replication: unknown,
  force: boolean,
  nowMs?: number,
  engine?: string,
  /**
   * True only when this promote will run a planned switchover with a fence:
   * the old primary's server is connected, so its final position is recorded
   * and the target waits for it. Without it an idle-only reading is refused.
   */
  fenceWillRun?: boolean
):
  | null
  | 'managed_replica_not_streaming'
  | 'managed_replica_lagging'
  | 'managed_replica_health_stale'
  | 'managed_replica_not_fully_applied' {
  if (force) return null
  const gate = evaluateManagedPromoteLagGate(replication, nowMs, {
    staleMs: OPERATOR_PROMOTE_MAX_OBSERVATION_AGE_MS,
  })
  if (gate !== null) return gate
  if (!isPlainObject(replication)) return null
  if (engine === 'postgres') {
    const received = parsePgLsn(replication.receivedLsn)
    const replayed = parsePgLsn(replication.replayLsn)
    if (received === null || replayed === null) {
      return 'managed_replica_lagging'
    }
    if (received - replayed > BigInt(MAX_REPLAY_DELTA_BYTES)) {
      return 'managed_replica_lagging'
    }
    return null
  }
  if (isMysqlFamilyEngine(engine) && replication.fullyApplied !== true) {
    // An explicit false is behind. A missing reading is only accepted for MySQL
    // (not MariaDB, whose positions mean something else) when a fence will run
    // (old primary connected; never the dead-source or no-primary paths), and
    // for an idle pair: the replica reports its applied set but has received nothing
    // since it started (no received set), both threads run, and lag is zero.
    // The planned switchover itself then proves the final position: it stops
    // the old primary, records its last GTID set and makes the target wait for
    // it before promoting, aborting (and reactivating the old primary) on a
    // timeout. Failover never comes through this gate.
    if (
      replication.fullyApplied === false ||
      engine !== 'mysql' ||
      fenceWillRun !== true ||
      !isIdleMysqlReplicaReading(replication)
    ) {
      return 'managed_replica_not_fully_applied'
    }
  }
  return null
}

/**
 * True when a reading that passed {@link evaluateOperatorPromoteGate} passed
 * only on the idle MySQL clause (no `fullyApplied: true`). Such a promote must
 * fence the old primary and wait for its recorded final position; if the old
 * primary drops offline before the fence starts, the switchover is refused
 * rather than promoting with no position to wait for.
 */
export function operatorPromoteRequiresFence(
  replication: unknown,
  force: boolean,
  engine?: string
): boolean {
  if (force || !isMysqlFamilyEngine(engine)) return false
  return !isPlainObject(replication) || replication.fullyApplied !== true
}

function isIdleMysqlReplicaReading(replication: Record<string, unknown>): boolean {
  return (
    replication.state === 'streaming' &&
    replication.lagSeconds === 0 &&
    replication.receivedGtid === undefined &&
    typeof replication.executedGtid === 'string' &&
    replication.executedGtid.length > 0
  )
}

export type QueuedCommandFanoutRow = {
  commandId?: string
  serverId?: string
}

/**
 * Prefer the first fan-out row that already has a command id (primary), else
 * the first row — matches every managed enqueue response.
 */
export function pickPrimaryCommandResult<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[]
): T | undefined {
  return enqueued.find((r) => r.commandId) ?? enqueued[0]
}

export function buildQueuedFanoutResponse<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
  fallbackServerId: string
): {
  ok: true
  results: readonly T[]
  commandId: string | undefined
  serverId: string
  status: 'queued'
} {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    results: enqueued,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    status: 'queued' as const,
  }
}

/**
 * Detail shape for an environment whose managed row does not exist yet. `ssl`
 * is still resolved so the create surface can state the TLS policy a new
 * cluster will inherit instead of leaving it blank until after provisioning.
 * `rootUsername` is `null`: the administrative login (`postgres_<11 rand>` /
 * `root_<11 rand>`) is generated at create and unknowable before it.
 */
export function buildEmptyManagedDetailResponse(organizationSslMode?: ManagedSslMode | undefined) {
  return {
    managed: null,
    connection: null,
    endpoints: [] as const,
    connections: [] as const,
    addressNeeded: false,
    exposure: null,
    settings: null,
    ssl: buildManagedSslView(undefined, organizationSslMode),
    release: null,
    server: null,
    rootUsername: null,
    members: [] as const,
    recovery: null,
  }
}

/**
 * `configured` is the service override (`null` = inheriting); `effective` is
 * what ProxySQL enforces and DSNs render, so the UI can label the inherit
 * option with what it resolves to without recomputing the hierarchy.
 * `raisedForExternalAccess` (from `resolveEffectiveManagedSsl`) means the
 * resolved mode let clients skip SSL and `effective` was raised to `require`
 * because a server serving the cluster allows external access.
 */
export function buildManagedSslView(
  configured: ManagedSslMode | undefined,
  organizationDefault: ManagedSslMode | undefined,
  raisedForExternalAccess = false
) {
  return {
    configured: configured ?? null,
    effective: raisedForExternalAccess
      ? MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS
      : resolveManagedSslMode(configured, organizationDefault),
    organizationDefault: organizationDefault ?? null,
    raisedForExternalAccess,
  }
}

export type ManagedReleaseView = {
  /** Operator-facing version (`18`, `9.7`, `12.3`). */
  series: string
  variantId: string
  lifecycle: string
  /**
   * False when the running series is catalogued but no longer creatable — the
   * UI surfaces it as unsupported rather than silently showing a normal version.
   */
  tested: boolean
  image: string
}

/**
 * Catalog identity of the image this cluster runs, derived rather than stored
 * so `settings.image` stays the single persisted source of truth. `null` when
 * the resolved image is outside the catalog (an engine with no catalog, or a
 * series retired after the row was written) — the UI then falls back to showing
 * the raw image.
 */
export function buildManagedReleaseView(
  spec: { defaultImage: string; legacyDefaultImage?: string },
  settings: ManagedSettings
): ManagedReleaseView | null {
  const image = effectiveManagedImage(spec, settings.image)
  const descriptor = describeManagedImage(image)
  if (!descriptor) return null
  return {
    series: descriptor.series,
    variantId: descriptor.variantId,
    lifecycle: descriptor.lifecycle,
    tested: descriptor.tested,
    image,
  }
}

/**
 * Status endpoint member row — same identity field as detail (`id`), not
 * `memberId`. The UI merges status onto detail by id; a different key
 * produced a ghost second "primary" with no React key.
 */
export function buildStatusMemberView(serialized: {
  id: string
  serverId: string
  role: string
  replicaClass?: string | null
  status: string | null
  replicationTransport: string | null
  privatePort: number | null
  replication?: unknown
}) {
  return {
    id: serialized.id,
    serverId: serialized.serverId,
    role: serialized.role,
    replicaClass: serialized.replicaClass ?? null,
    status: serialized.status,
    replicationTransport: serialized.replicationTransport,
    privatePort: serialized.privatePort,
    ...(serialized.replication !== undefined ? { replication: serialized.replication } : {}),
  }
}

export function buildManagedDestroyQueuedResponse(params: { commandId: string; serverId: string }) {
  return {
    ok: true as const,
    destroyCommandId: params.commandId,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
  }
}

export type ManagedHostCleanupRow = {
  serverId: string
  status: 'queued' | 'failed'
  online: boolean
}

/**
 * One row per member host for a force-delete: enqueue outcome plus whether
 * that host is connected right now (offline hosts still get a long-lived
 * destroy; they run it when they reconnect).
 */
export function buildManagedForceHostCleanup(
  members: readonly { serverId: string }[],
  enqueued: readonly { serverId: string; status: 'queued' | 'failed' }[],
  onlineByServerId: ReadonlyMap<string, boolean>
): ManagedHostCleanupRow[] {
  const statusByServer = new Map<string, 'queued' | 'failed'>()
  for (const row of enqueued) {
    if (row.status === 'failed') {
      statusByServer.set(row.serverId, 'failed')
      continue
    }
    if (statusByServer.get(row.serverId) !== 'failed') {
      statusByServer.set(row.serverId, 'queued')
    }
  }
  const seen = new Set<string>()
  const hostCleanup: ManagedHostCleanupRow[] = []
  for (const member of members) {
    if (seen.has(member.serverId)) continue
    seen.add(member.serverId)
    hostCleanup.push({
      serverId: member.serverId,
      status: statusByServer.get(member.serverId) ?? 'failed',
      online: onlineByServerId.get(member.serverId) === true,
    })
  }
  return hostCleanup
}

export function buildManagedDeleteHardResponse(params?: {
  hostCleanup?: readonly ManagedHostCleanupRow[]
}) {
  const hostCleanup = params?.hostCleanup
  if (!hostCleanup || hostCleanup.length === 0) {
    return { ok: true as const, deleted: true as const }
  }
  const offlineCount = hostCleanup.filter((row) => !row.online).length
  return {
    ok: true as const,
    deleted: true as const,
    hostCleanup: [...hostCleanup],
    ...(offlineCount > 0
      ? {
          note: `The cleanup will run when ${offlineCount} offline server(s) reconnect within 7 days.`,
        }
      : {}),
  }
}

export function buildManagedDeleteQueuedResponse<T extends QueuedCommandFanoutRow>(
  enqueued: readonly T[],
  fallbackServerId: string
) {
  const primary = pickPrimaryCommandResult(enqueued)
  return {
    ok: true as const,
    deleted: false as const,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? fallbackServerId,
    results: enqueued,
  }
}

export function buildFencePromotePendingResponse(params: { commandId: string; serverId: string }) {
  return {
    ok: true as const,
    commandId: params.commandId,
    serverId: params.serverId,
    status: 'queued' as const,
    fenceCommandId: params.commandId,
    promotePending: true as const,
  }
}

export function buildPromoteQueuedResponse(params: { commandId: string; serverId: string }) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}

export type OperatorPromoteRecoveryInput =
  | { ok: false; error: string; status: 409 | 422 | 503 }
  | { ok: true; commandId: string; serverId: string; fencePending: boolean }

export type OperatorPromoteHttpResult =
  | { status: 409 | 422 | 503; body: { error: string } }
  | {
      status: 200
      body:
        | ReturnType<typeof buildFencePromotePendingResponse>
        | ReturnType<typeof buildPromoteQueuedResponse>
    }

/**
 * Map a switchover enqueue result onto the promote HTTP body. Extracted so
 * POST …/members/:memberId/promote stays under the route-handler complexity
 * budget.
 */
export function operatorPromoteHttpResult(
  recovery: OperatorPromoteRecoveryInput
): OperatorPromoteHttpResult {
  if (!recovery.ok) {
    return { status: recovery.status, body: { error: recovery.error } }
  }
  const queued = {
    commandId: recovery.commandId,
    serverId: recovery.serverId,
  }
  if (recovery.fencePending) {
    return { status: 200, body: buildFencePromotePendingResponse(queued) }
  }
  return { status: 200, body: buildPromoteQueuedResponse(queued) }
}

export function buildDisasterRecoveryQueuedResponse(params: {
  commandId: string
  serverId: string
  fencePending: boolean
  lagBytes: number | null
  sourceMemberId: string
  sourceServerId: string
  sourceDatacenterId: string | null
  targetMemberId: string
  targetServerId: string
  targetDatacenterId: string | null
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
    fencePending: params.fencePending,
    kind: 'disaster-recovery' as const,
    lagBytes: params.lagBytes,
    source: {
      memberId: params.sourceMemberId,
      serverId: params.sourceServerId,
      datacenterId: params.sourceDatacenterId,
    },
    target: {
      memberId: params.targetMemberId,
      serverId: params.targetServerId,
      datacenterId: params.targetDatacenterId,
    },
  }
}

type OrgManagedListEntryExtras = {
  engineDisplayName: string | null
  environmentName: string | null
  projectId: string
  projectName: string | null
  workspaceId: string
  workspaceName: string | null
  serverName: string | null
  members: unknown[]
}

export function buildOrgManagedListEntry<T extends Record<string, unknown>>(
  params: OrgManagedListEntryExtras & { serializedRow: T }
): T & OrgManagedListEntryExtras {
  return {
    ...params.serializedRow,
    engineDisplayName: params.engineDisplayName,
    environmentName: params.environmentName,
    projectId: params.projectId,
    projectName: params.projectName,
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    serverName: params.serverName,
    members: params.members,
  }
}

type OrgManagedListSourceRow = {
  id: string
  environmentId: string | null
  name: string | null
  engine: string | null
  status: string | null
  metadata: unknown
  options: unknown
  serverId: string | null
  createdAt: string
  updatedAt: string
  environmentServerId: string | null
  environmentDisplayName: string | null
  projectId: string
  projectDisplayName: string | null
  workspaceId: string
  workspaceDisplayName: string | null
  serverDisplayName: string | null
}

/** One `GET /organizations/:id/managed` row — shared listener on loopback, no residual backend ports. */
export async function serializeOrgManagedListRow(
  db: Db,
  row: OrgManagedListSourceRow,
  members: unknown[],
  serverNamesById: ReadonlyMap<string, string | null> = new Map()
) {
  const spec = row.engine ? getManagedEngineSpec(row.engine) : null
  const resolvedServerId = resolveManagedServerId(
    { serverId: row.serverId },
    row.environmentServerId
  )
  const serverName =
    resolvedServerId === null ? null : (serverNamesById.get(resolvedServerId) ?? null)
  const listenerParams = managedStatusListenerParams({
    serverId: resolvedServerId,
    engine: row.engine,
    options: row.options,
  })
  const listener = listenerParams ? await resolveManagedLoopbackListener(db, listenerParams) : null
  return buildOrgManagedListEntry({
    serializedRow: serializeManagedRow(
      row,
      resolvedServerId,
      listener ? { host: listener.host, port: listener.port } : { host: null, port: null }
    ),
    engineDisplayName: spec?.displayName ?? null,
    environmentName: row.environmentDisplayName,
    projectId: row.projectId,
    projectName: row.projectDisplayName,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceDisplayName,
    serverName,
    members,
  })
}
