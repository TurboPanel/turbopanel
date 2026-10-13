/**
 * Placements: where a system principal is a Linux account, one row per
 * (principal, server). See `schema.ts` `principalPlacement`.
 *
 * Writers, in host order: deploy fan-out records `pending` for every account
 * the queued deploy materializes, the deploy result turns it `present`, a
 * teardown stop that names the account in `retirePrincipals` turns it
 * `retiring`, and that stop's result turns it `absent`. The implicit reach
 * (project → environment.server_id) still decides what the daemon is sent;
 * these rows are bookkeeping beside it until the reach is retired.
 *
 * Every writer here is best-effort from the caller's point of view (a deploy
 * or a stop must never fail because bookkeeping did, so the callers wrap
 * these in a warn-and-continue), except `ensureProjectPlacements`, which runs
 * inside the project delete's transaction and fails it closed.
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  binding,
  login,
  principal,
  principalPlacement,
  secret,
  service,
  storage,
  tenancy,
} from '../../db/schema.ts'
import { SERVER_PRINCIPAL_PROVIDER } from './store.ts'
import type { PlacementSource, PlacementState } from './placement-vocabulary.ts'

export type { PlacementSource, PlacementState } from './placement-vocabulary.ts'

export type PlacementInput = {
  principalId: string
  /** Account home on the host (`principalHomeDir(appliedUsername)`). */
  home: string
  source: PlacementSource
}

/**
 * Why an account is on a server. A compose alias wins because the compose
 * document is what keeps re-creating it; a principal that reaches the server
 * only through a storage entry it owns is `storage`; everything else is a
 * project principal someone created by hand.
 */
export function placementSourceFor(
  facts: Readonly<{ composeAlias: boolean; viaTenancy: boolean; viaStorage: boolean }>
): PlacementSource {
  if (facts.composeAlias) return 'compose'
  if (facts.viaStorage && !facts.viaTenancy) return 'storage'
  return 'manual'
}

function parseComposeAlias(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') return false
  const alias = (metadata as Record<string, unknown>).composeAlias
  return typeof alias === 'string' && alias.length > 0
}

/**
 * Resolve the placement inputs for the principals one deploy sends to a
 * server: the environment's tenancy principals plus the storage owners.
 */
export async function resolvePlacementInputs(
  db: Db,
  params: Readonly<{
    environmentId: string
    principals: ReadonlyArray<{ principalId: string; home: string }>
    storagePrincipalIds: ReadonlyArray<string>
  }>
): Promise<PlacementInput[]> {
  const ids = [...new Set(params.principals.map((entry) => entry.principalId))]
  if (ids.length === 0) return []
  const rows = await db
    .select({ id: principal.id, metadata: principal.metadata, kind: principal.kind })
    .from(principal)
    .where(inArray(principal.id, ids))
  const tenancyRows = await db
    .select({ principalId: tenancy.principalId })
    .from(tenancy)
    .innerJoin(service, eq(tenancy.serviceId, service.id))
    .where(and(eq(service.environmentId, params.environmentId), inArray(tenancy.principalId, ids)))
  const viaTenancy = new Set(tenancyRows.map((row) => row.principalId))
  const viaStorage = new Set(params.storagePrincipalIds)
  const composeById = new Map(rows.map((row) => [row.id, parseComposeAlias(row.metadata)]))
  const systemIds = new Set(rows.filter((row) => row.kind === 'system').map((row) => row.id))

  const inputs: PlacementInput[] = []
  const seen = new Set<string>()
  for (const entry of params.principals) {
    if (seen.has(entry.principalId) || !systemIds.has(entry.principalId)) continue
    seen.add(entry.principalId)
    inputs.push({
      principalId: entry.principalId,
      home: entry.home,
      source: placementSourceFor({
        composeAlias: composeById.get(entry.principalId) ?? false,
        viaTenancy: viaTenancy.has(entry.principalId),
        viaStorage: viaStorage.has(entry.principalId),
      }),
    })
  }
  return inputs
}

/**
 * A deploy that materializes these accounts on `serverId` is queued. A row
 * already `present` stays so (the account is there whatever this deploy
 * does); any other state becomes `pending`.
 */
export async function recordPendingPlacements(
  db: Db,
  serverId: string,
  inputs: ReadonlyArray<PlacementInput>
): Promise<void> {
  if (inputs.length === 0) return
  const now = new Date().toISOString()
  await db
    .insert(principalPlacement)
    .values(
      inputs.map((input) => ({
        principalId: input.principalId,
        serverId,
        state: 'pending' satisfies PlacementState,
        home: input.home,
        source: input.source,
      }))
    )
    .onConflictDoUpdate({
      target: [principalPlacement.principalId, principalPlacement.serverId],
      set: {
        state: sql`CASE WHEN ${principalPlacement.state} = 'present' THEN 'present' ELSE 'pending' END`,
        home: sql`excluded.home`,
        source: sql`excluded.source`,
        updatedAt: now,
      },
    })
}

/**
 * Record a `present` placement for every system principal of `projectId` on
 * every server the project reaches (pinned or deployed): the 0031 backfill,
 * scoped to one project, and a `pending` row left by a deploy whose result
 * was never recorded moves to `present`. `retiring` / `absent` rows are left
 * alone. Project delete runs it inside its transaction, after the refusal
 * checks: afterwards the placements are the only record of where the accounts
 * live, and an unrecorded account would lose its key files on the next
 * reconcile. Unlike the other writers here it is not best-effort — it runs in
 * the delete's transaction, so a failure fails the delete closed.
 */
export async function ensureProjectPlacements(db: Db, projectId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "placement" ("principal_id", "server_id", "state", "home", "source")
    SELECT DISTINCT
      p."id",
      reach."server_id",
      'present',
      '/srv/users/' || p."applied_username",
      CASE WHEN COALESCE(p."metadata" ->> 'composeAlias', '') <> '' THEN 'compose' ELSE 'manual' END
    FROM "principal" p
    JOIN (
      SELECT e."project_id", e."server_id" FROM "environment" e
      WHERE e."server_id" IS NOT NULL AND e."project_id" = ${projectId}
      UNION
      SELECT e."project_id", d."server_id" FROM "deployment" d
      JOIN "environment" e ON e."id" = d."environment_id"
      WHERE e."project_id" = ${projectId}
    ) reach ON reach."project_id" = p."project_id"
    WHERE p."kind" = 'system' AND p."provider" = ${SERVER_PRINCIPAL_PROVIDER} AND p."project_id" = ${projectId}
    ON CONFLICT ("principal_id", "server_id") DO UPDATE
      SET "state" = 'present', "updated_at" = now()
      WHERE "placement"."state" = 'pending'
  `)
}

/** The deploy that carried these accounts to `serverId` succeeded. */
export async function markPlacementsPresent(
  db: Db,
  serverId: string,
  principalIds: ReadonlyArray<string>
): Promise<void> {
  if (principalIds.length === 0) return
  await db
    .update(principalPlacement)
    .set({ state: 'present' satisfies PlacementState })
    .where(
      and(
        eq(principalPlacement.serverId, serverId),
        inArray(principalPlacement.principalId, [...principalIds]),
        ne(principalPlacement.state, 'present')
      )
    )
}

/**
 * Placements on `serverId` whose principal's applied login is one of
 * `usernames` — the key `environment.stop` `retirePrincipals` carries.
 */
async function placementIdsByUsername(
  db: Db,
  serverId: string,
  usernames: ReadonlyArray<string>
): Promise<string[]> {
  const rows = await db
    .select({ id: principalPlacement.id })
    .from(principalPlacement)
    .innerJoin(principal, eq(principalPlacement.principalId, principal.id))
    .where(
      and(
        eq(principalPlacement.serverId, serverId),
        eq(principal.provider, SERVER_PRINCIPAL_PROVIDER),
        inArray(principal.appliedUsername, [...usernames])
      )
    )
  return rows.map((row) => row.id)
}

async function setPlacementStateByUsername(
  db: Db,
  serverId: string,
  usernames: ReadonlyArray<string>,
  state: PlacementState,
  /** Only rows in this state move; others are left alone. */
  fromState?: PlacementState
): Promise<void> {
  if (usernames.length === 0) return
  const ids = await placementIdsByUsername(db, serverId, usernames)
  if (ids.length === 0) return
  await db
    .update(principalPlacement)
    .set({ state })
    .where(
      and(
        inArray(principalPlacement.id, ids),
        fromState === undefined
          ? ne(principalPlacement.state, state)
          : eq(principalPlacement.state, fromState)
      )
    )
}

/** A stop naming these accounts in `retirePrincipals` is queued for `serverId`. */
export function markPlacementsRetiring(
  db: Db,
  serverId: string,
  usernames: ReadonlyArray<string>
): Promise<void> {
  return setPlacementStateByUsername(db, serverId, usernames, 'retiring')
}

/**
 * That stop succeeded. Only a `retiring` row moves: a stop result that lands
 * after a newer deploy already re-recorded the account `pending` must not
 * undo it. Best effort by construction: the daemon logs a refused
 * `principal-remove` and keeps the account while the stop itself succeeds,
 * and the stop result does not say which accounts went.
 */
export function markPlacementsAbsent(
  db: Db,
  serverId: string,
  usernames: ReadonlyArray<string>
): Promise<void> {
  return setPlacementStateByUsername(db, serverId, usernames, 'absent', 'retiring')
}

export type ServerPlacementRow = {
  id: string
  principalId: string
  username: string
  appliedUsername: string
  projectId: string | null
  state: PlacementState
  uid: number | null
  gid: number | null
  home: string
  source: PlacementSource
}

/** Every placement on one server, with the principal's names. */
export async function listServerPlacements(
  db: Db,
  serverId: string
): Promise<ServerPlacementRow[]> {
  const rows = await db
    .select({
      id: principalPlacement.id,
      principalId: principalPlacement.principalId,
      username: principal.username,
      appliedUsername: principal.appliedUsername,
      projectId: principal.projectId,
      state: principalPlacement.state,
      uid: principalPlacement.uid,
      gid: principalPlacement.gid,
      home: principalPlacement.home,
      source: principalPlacement.source,
    })
    .from(principalPlacement)
    .innerJoin(principal, eq(principalPlacement.principalId, principal.id))
    .where(eq(principalPlacement.serverId, serverId))
  return rows
    .map((row) => ({
      ...row,
      state: row.state as PlacementState,
      source: row.source as PlacementSource,
    }))
    .sort((a, b) => a.appliedUsername.localeCompare(b.appliedUsername))
}

/**
 * What else still uses a principal, counted per kind. `logins` are the
 * principal's database logins (its other form). `otherPlacements` leaves out
 * `excludeServerId` (the server being removed) and rows already `absent`.
 */
export type PrincipalUsage = {
  tenancies: number
  bindings: number
  storages: number
  secrets: number
  logins: number
  otherPlacements: number
}

export const PRINCIPAL_USAGE_KINDS = [
  'tenancies',
  'bindings',
  'storages',
  'secrets',
  'logins',
  'otherPlacements',
] as const satisfies ReadonlyArray<keyof PrincipalUsage>

export function emptyPrincipalUsage(): PrincipalUsage {
  return { tenancies: 0, bindings: 0, storages: 0, secrets: 0, logins: 0, otherPlacements: 0 }
}

/** True when nothing but the placement under review still uses the principal. */
export function isPrincipalUnused(usage: PrincipalUsage): boolean {
  return PRINCIPAL_USAGE_KINDS.every((kind) => usage[kind] === 0)
}

async function countByPrincipal(
  rows: Promise<Array<{ principalId: string | null }>>,
  into: Map<string, PrincipalUsage>,
  kind: keyof PrincipalUsage
): Promise<void> {
  for (const row of await rows) {
    if (row.principalId === null) continue
    const usage = into.get(row.principalId)
    if (usage) usage[kind] += 1
  }
}

export async function loadPrincipalUsage(
  db: Db,
  principalIds: ReadonlyArray<string>,
  excludeServerId: string
): Promise<Map<string, PrincipalUsage>> {
  const usage = new Map<string, PrincipalUsage>()
  const ids = [...new Set(principalIds)]
  for (const id of ids) usage.set(id, emptyPrincipalUsage())
  if (ids.length === 0) return usage

  await countByPrincipal(
    db
      .select({ principalId: tenancy.principalId })
      .from(tenancy)
      .where(inArray(tenancy.principalId, ids)),
    usage,
    'tenancies'
  )
  await countByPrincipal(
    db
      .select({ principalId: binding.principalId })
      .from(binding)
      .where(inArray(binding.principalId, ids)),
    usage,
    'bindings'
  )
  await countByPrincipal(
    db
      .select({ principalId: storage.principalId })
      .from(storage)
      .where(and(isNotNull(storage.principalId), inArray(storage.principalId, ids))),
    usage,
    'storages'
  )
  await countByPrincipal(
    db
      .select({ principalId: secret.principalId })
      .from(secret)
      .where(and(isNotNull(secret.principalId), inArray(secret.principalId, ids))),
    usage,
    'secrets'
  )
  await countByPrincipal(
    db
      .select({ principalId: login.principalId })
      .from(login)
      .where(and(isNotNull(login.principalId), inArray(login.principalId, ids))),
    usage,
    'logins'
  )
  await countByPrincipal(
    db
      .select({ principalId: principalPlacement.principalId })
      .from(principalPlacement)
      .where(
        and(
          inArray(principalPlacement.principalId, ids),
          ne(principalPlacement.serverId, excludeServerId),
          ne(principalPlacement.state, 'absent')
        )
      ),
    usage,
    'otherPlacements'
  )
  return usage
}
