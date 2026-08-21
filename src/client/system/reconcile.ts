/**
 * Context-free system.reconcile enqueue helpers.
 *
 * Usable from request isolates (hosting PATCH / operate) and from the
 * Workers cron / Deno maintenance timer (drift sweep) without Hono context.
 *
 * Sweep-driven rows use `actorType: 'system'` with `actorId = serverId`.
 * `command.actor_id` is a `uuid NOT NULL` with no FK, so the server id is a
 * valid non-user actor for throttle / audit without inventing a synthetic user.
 *
 * A server may carry up to two system environments today: hosting-ingress
 * (any enrolled server) and self-host `turbopanel` (colocated server only).
 * `buildSystemReconcilePayload` resolves every system environment for the
 * server in one query and returns one payload per environment;
 * `enqueueSystemReconcile` creates one `system.reconcile` command per
 * payload (optionally scoped to a single `environmentId`).
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type {
  SystemReconcileAction,
  SystemReconcileCommandPayload,
  SystemReconcileComponent,
} from '../../lib/commands/schemas.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { parseServerOptions } from '../../lib/db/server-metadata.ts'
import {
  ingressContainerNameFromService,
  managedHaContainerNameFromService,
} from '../../lib/naming.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../lib/db/workspace-kind.ts'
import {
  findSystemEnvironmentForServer,
  isSystemSelfHostComposeServiceName,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
  SYSTEM_SELF_HOST_COMPONENT,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
  SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
} from './hierarchy.ts'

/** Matches the consumer timeout for `system.reconcile` (300 s). */
export const SYSTEM_RECONCILE_TTL_MS = 300_000

/** Minimum gap between sweep-driven enqueues for the same server. */
export const SYSTEM_RECONCILE_MIN_INTERVAL_MS = 5 * 60_000

const SYSTEM_RECONCILE_SWEEP_CAP = 100

type SystemReconcileEnvironmentRow = {
  environment_id: string
  project_component: string | null
  service_id: string
  name: string
}

type SystemReconcileQueryRow = SystemReconcileEnvironmentRow & {
  server_options: unknown
  has_http_ingress_demand: boolean
  has_managed_members: boolean
  has_ha_members: boolean
  has_bound_managed_consumers: boolean
  ingress_container_id: string | null
  ingress_status: string | null
}

type SystemReconcileEnvironmentEntry = {
  component: string | null
  hostingEnabled: boolean
  /**
   * True when at least one HTTP hosting with hostnames is placed on this
   * server — the shared Traefik is only desired after something needs it.
   */
  hasHttpIngressDemand: boolean
  /**
   * True when the ingress row was observed on Docker before (container id
   * stamped or status running) — keep self-healing after first start even
   * if hostings are temporarily cleared, until hosting is disabled.
   */
  ingressObserved: boolean
  /**
   * True when this server hosts at least one managed cluster `node` row.
   */
  hasManagedMembers: boolean
  /**
   * True when this server is a bound consumer of a managed cluster
   * (environment pin, project default, or task pin) — ProxySQL is desired
   * even with no local members.
   */
  hasBoundManagedConsumers: boolean
  /**
   * True when this server hosts a primary or failover replica (Orchestrator Raft).
   */
  hasHaMembers: boolean
  services: Array<{ serviceId: string; composeServiceName: string }>
}

/**
 * Shared loopback Traefik should be running only when hosting is enabled and
 * either something HTTP is routing hostnames through it, or it was already
 * brought up (crash/reconnect recovery). Pending inventory alone must not
 * start a bare `-in` proxy.
 */
export function resolveHostingIngressDesired(params: Readonly<{
  hostingEnabled: boolean
  hasHttpIngressDemand: boolean
  ingressObserved: boolean
}>): 'present' | 'absent' {
  if (!params.hostingEnabled) return 'absent'
  if (params.hasHttpIngressDemand || params.ingressObserved) return 'present'
  return 'absent'
}

/**
 * Shared ProxySQL is desired when this server hosts managed members **or**
 * is a bound consumer of a managed cluster (environment pin, project
 * default, or task pin). Absent inventory alone must not keep it up once
 * both are gone.
 */
export function resolveManagedIngressDesired(params: Readonly<{
  hasManagedMembers: boolean
  hasBoundManagedConsumers: boolean
}>): 'present' | 'absent' {
  if (params.hasManagedMembers || params.hasBoundManagedConsumers) {
    return 'present'
  }
  return 'absent'
}

/** Orchestrator is desired only on servers that host a primary or failover replica. */
export function resolveManagedHaDesired(params: Readonly<{
  hasHaMembers: boolean
}>): 'present' | 'absent' {
  return params.hasHaMembers ? 'present' : 'absent'
}

/** Build the per-environment component list from its identity + service rows. */
function buildSystemReconcileComponents(
  entry: SystemReconcileEnvironmentEntry,
): SystemReconcileComponent[] {
  if (entry.component === SYSTEM_HOSTING_INGRESS_COMPONENT) {
    const traefik = entry.services.find(
      (svc) => svc.composeServiceName === SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
    )
    if (!traefik) return []
    return [
      {
        component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        serviceId: traefik.serviceId,
        composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
        containerName: ingressContainerNameFromService(traefik.serviceId),
        role: 'ingress',
        desired: resolveHostingIngressDesired({
          hostingEnabled: entry.hostingEnabled,
          hasHttpIngressDemand: entry.hasHttpIngressDemand,
          ingressObserved: entry.ingressObserved,
        }),
      },
    ]
  }

  if (entry.component === SYSTEM_MANAGED_INGRESS_COMPONENT) {
    const proxysql = entry.services.find(
      (svc) => svc.composeServiceName === SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
    )
    if (!proxysql) return []
    return [
      {
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId: proxysql.serviceId,
        composeServiceName: SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME,
        containerName: ingressContainerNameFromService(proxysql.serviceId),
        role: 'ingress',
        desired: resolveManagedIngressDesired({
          hasManagedMembers: entry.hasManagedMembers,
          hasBoundManagedConsumers: entry.hasBoundManagedConsumers,
        }),
      },
    ]
  }

  if (entry.component === SYSTEM_MANAGED_HA_COMPONENT) {
    const orchestrator = entry.services.find(
      (svc) => svc.composeServiceName === SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    )
    if (!orchestrator) return []
    return [
      {
        component: SYSTEM_MANAGED_HA_COMPONENT,
        serviceId: orchestrator.serviceId,
        composeServiceName: SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
        containerName: managedHaContainerNameFromService(orchestrator.serviceId),
        role: 'turbopanel',
        desired: resolveManagedHaDesired({
          hasHaMembers: entry.hasHaMembers,
        }),
      },
    ]
  }

  if (entry.component === SYSTEM_SELF_HOST_COMPONENT) {
    const components: SystemReconcileComponent[] = []
    for (const svc of entry.services) {
      if (!isSystemSelfHostComposeServiceName(svc.composeServiceName)) continue
      // Self-host database/queue/analytics are always desired — there is no
      // enable/disable toggle like hosting-ingress.
      components.push({
        component: svc.composeServiceName,
        serviceId: svc.serviceId,
        composeServiceName: svc.composeServiceName,
        containerName: svc.serviceId,
        role: 'turbopanel',
        desired: 'present',
      })
    }
    return components
  }

  return []
}

function rowShowsIngressObserved(row: SystemReconcileQueryRow): boolean {
  return row.ingress_container_id != null || row.ingress_status === 'running'
}

function newEnvironmentEntry(
  row: SystemReconcileQueryRow,
): SystemReconcileEnvironmentEntry {
  return {
    component: row.project_component,
    hostingEnabled:
      parseServerOptions(row.server_options)?.hosting?.enabled === true,
    hasHttpIngressDemand: row.has_http_ingress_demand === true,
    hasManagedMembers: row.has_managed_members === true,
    hasHaMembers: row.has_ha_members === true,
    hasBoundManagedConsumers: row.has_bound_managed_consumers === true,
    ingressObserved: rowShowsIngressObserved(row),
    services: [],
  }
}

function mergeEnvironmentRowFlags(
  entry: SystemReconcileEnvironmentEntry,
  row: SystemReconcileQueryRow,
): void {
  entry.hasHttpIngressDemand ||= row.has_http_ingress_demand === true
  entry.hasManagedMembers ||= row.has_managed_members === true
  entry.hasHaMembers ||= row.has_ha_members === true
  entry.hasBoundManagedConsumers ||= row.has_bound_managed_consumers === true
  entry.ingressObserved ||= rowShowsIngressObserved(row)
}

function groupSystemReconcileRows(
  rows: readonly SystemReconcileQueryRow[],
): Map<string, SystemReconcileEnvironmentEntry> {
  const byEnvironment = new Map<string, SystemReconcileEnvironmentEntry>()
  for (const row of rows) {
    let entry = byEnvironment.get(row.environment_id)
    if (!entry) {
      entry = newEnvironmentEntry(row)
      byEnvironment.set(row.environment_id, entry)
    }
    mergeEnvironmentRowFlags(entry, row)
    entry.services.push({
      serviceId: row.service_id,
      composeServiceName: row.name,
    })
  }
  return byEnvironment
}

function payloadsFromEnvironmentEntries(
  byEnvironment: Map<string, SystemReconcileEnvironmentEntry>,
): SystemReconcileCommandPayload[] {
  const payloads: SystemReconcileCommandPayload[] = []
  for (const [environmentId, entry] of byEnvironment) {
    const components = buildSystemReconcileComponents(entry)
    if (components.length === 0) continue
    payloads.push({ environmentId, action: 'reconcile', components })
  }
  return payloads
}

/**
 * Resolve every system-workspace environment pinned to this server (join
 * `project.metadata->>'component'` under a `workspace.kind='turbopanel'`
 * ancestor) and return one payload per environment. Desired state is
 * derived per environment:
 * - hosting-ingress: present only when hosting is enabled **and** some HTTP
 *   hostname hosting on this server needs the shared Traefik, or the
 *   ingress was already observed (self-heal after first start)
 * - managed-ingress: present when this server hosts managed members **or**
 *   bound managed consumers (environment pin, project default, or task pin)
 * - self-host (`turbopanel`) components are always `'present'`
 *
 * Returns an empty array when no system hierarchy is provisioned for the
 * server yet.
 */
export async function buildSystemReconcilePayload(
  db: Db,
  params: Readonly<{ serverId: string }>,
): Promise<SystemReconcileCommandPayload[]> {
  const rows = await db.execute<SystemReconcileQueryRow>(sql`
    SELECT
      e.id AS environment_id,
      p.metadata->>'component' AS project_component,
      s.id AS service_id,
      s.name AS name,
      srv.options AS server_options,
      EXISTS (
        SELECT 1
        FROM hosting h
        JOIN service hs ON hs.id = h.service_id
        JOIN environment he ON he.id = hs.environment_id
        WHERE he.server_id = ${params.serverId}::uuid
          AND COALESCE(h.options->>'protocol', 'http') = 'http'
          AND jsonb_typeof(h.options->'hostnames') = 'array'
          AND jsonb_array_length(h.options->'hostnames') > 0
      ) AS has_http_ingress_demand,
      EXISTS (
        SELECT 1
        FROM node mm
        WHERE mm.server_id = ${params.serverId}::uuid
      ) AS has_managed_members,
      EXISTS (
        SELECT 1
        FROM node hm
        WHERE hm.server_id = ${params.serverId}::uuid
          AND (hm.role = 'primary' OR hm.replica_class = 'failover')
      ) AS has_ha_members,
      EXISTS (
        SELECT 1
        FROM binding b
        JOIN service bs ON bs.id = b.service_id
        JOIN environment be ON be.id = bs.environment_id
        JOIN project bp ON bp.id = be.project_id
        JOIN workspace bw ON bw.id = bp.workspace_id
        JOIN principal pr ON pr.id = b.principal_id
        LEFT JOIN task t ON t.service_id = bs.id
        WHERE bw.organization_id = srv.organization_id
          AND pr.managed_id IS NOT NULL
          AND (
            be.server_id = ${params.serverId}::uuid
            OR t.server_id = ${params.serverId}::uuid
            OR (
              be.server_id IS NULL
              AND bp.options->>'defaultServerId' = ${params.serverId}
            )
          )
      ) AS has_bound_managed_consumers,
      c.container_id AS ingress_container_id,
      c.status AS ingress_status
    FROM environment e
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    JOIN service s ON s.environment_id = e.id
    JOIN server srv ON srv.id = e.server_id
    LEFT JOIN container c
      ON c.service_id = s.id
      AND c.ordinal = 1
      AND (
        (p.metadata->>'component' = ${SYSTEM_HOSTING_INGRESS_COMPONENT} AND c.role = 'ingress')
        OR (p.metadata->>'component' = ${SYSTEM_MANAGED_INGRESS_COMPONENT} AND c.role = 'ingress')
        OR (p.metadata->>'component' = ${SYSTEM_MANAGED_HA_COMPONENT} AND c.role = 'turbopanel')
        OR (p.metadata->>'component' = ${SYSTEM_SELF_HOST_COMPONENT} AND c.role = 'turbopanel')
      )
    WHERE e.server_id = ${params.serverId}::uuid
      AND w.kind = ${WORKSPACE_KIND_TURBOPANEL}
    ORDER BY e.id, s.name
  `)

  return payloadsFromEnvironmentEntries(groupSystemReconcileRows(rows))
}

export type EnqueueSystemReconcileParams = Readonly<{
  serverId: string
  actorType: 'user' | 'system'
  actorId: string
  action?: SystemReconcileAction
  /**
   * Scope enqueue to a single system environment (e.g. the operate/restart
   * route, which only ever targets hosting-ingress). Omit to enqueue one
   * command per system environment resolved for the server.
   */
  environmentId?: string
}>

export type EnqueueSystemReconcileResult =
  | {
      ok: true
      /** First enqueued command id — kept for back-compat with single-command callers. */
      commandId: string
      commandIds: string[]
      serverId: string
    }
  | { ok: false; reason: 'not_provisioned' | 'enqueue_failed' }

export type EnqueueSystemReconcileIfConnectedResult =
  | EnqueueSystemReconcileResult
  | { ok: false; reason: 'not_connected' }

/**
 * Create + enqueue one `system.reconcile` command per resolved system
 * environment (or the single environment matching `params.environmentId`
 * when provided). Compensates to `failed` when the queue rejects a given
 * command (same shape as `enqueueCommandOrCompensate`); a partial failure
 * still returns `ok: true` with whichever commands succeeded, unless none did.
 */
export async function enqueueSystemReconcile(
  db: Db,
  commandQueue: CommandQueue,
  params: EnqueueSystemReconcileParams,
): Promise<EnqueueSystemReconcileResult> {
  const built = await buildSystemReconcilePayload(db, {
    serverId: params.serverId,
  })
  const scoped = params.environmentId
    ? built.filter((payload) => payload.environmentId === params.environmentId)
    : built
  if (scoped.length === 0) return { ok: false, reason: 'not_provisioned' }

  const action = params.action ?? 'reconcile'
  const expiresAt = new Date(Date.now() + SYSTEM_RECONCILE_TTL_MS).toISOString()

  const commandIds: string[] = []
  for (const built of scoped) {
    const payload: SystemReconcileCommandPayload = { ...built, action }

    const record = await createCommandRecord(db, {
      serverId: params.serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      type: 'system.reconcile',
      payload,
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: params.serverId,
      type: 'system.reconcile',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }

    try {
      await commandQueue.enqueue(envelope)
      commandIds.push(record.id)
    } catch {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: 'Command queue unavailable',
      })
    }
  }

  if (commandIds.length === 0) return { ok: false, reason: 'enqueue_failed' }

  return {
    ok: true,
    commandId: commandIds[0],
    commandIds,
    serverId: params.serverId,
  }
}

/**
 * True when at least one HTTP hosting with hostnames is still placed on this
 * server — the same demand test `buildSystemReconcilePayload` derives
 * `hosting-ingress` desired state from.
 */
export async function hasHttpIngressDemand(
  db: Db,
  serverId: string,
): Promise<boolean> {
  const rows = await db.execute<{ has_demand: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM hosting h
      JOIN service hs ON hs.id = h.service_id
      JOIN environment he ON he.id = hs.environment_id
      WHERE he.server_id = ${serverId}::uuid
        AND COALESCE(h.options->>'protocol', 'http') = 'http'
        AND jsonb_typeof(h.options->'hostnames') = 'array'
        AND jsonb_array_length(h.options->'hostnames') > 0
    ) AS has_demand
  `)
  return rows[0]?.has_demand === true
}

/**
 * Retire the shared HTTP Traefik once the last hostname hosting leaves a
 * server (project / environment delete). Bring-up is demand-driven, so
 * tear-down has to be too — `desired: 'absent'` drift alone stays report-only
 * on the daemon, which would otherwise leave the proxy resident forever.
 *
 * Scoped `action: 'stop'` on the hosting-ingress environment, matching the
 * hosting-disable PATCH. Best effort: never throws, no-op when demand remains
 * or the server has no system hierarchy yet.
 */
export async function retireHostingIngressIfIdle(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string
    actorType: 'user' | 'system'
    actorId: string
  }>,
): Promise<'stopped' | 'demand_remains' | 'skipped'> {
  try {
    if (await hasHttpIngressDemand(db, params.serverId)) return 'demand_remains'

    const environmentId = await findSystemEnvironmentForServer(
      db,
      params.serverId,
      SYSTEM_HOSTING_INGRESS_COMPONENT,
    )
    if (!environmentId) return 'skipped'

    const enqueued = await enqueueSystemReconcile(db, commandQueue, {
      serverId: params.serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      action: 'stop',
      environmentId,
    })
    return enqueued.ok ? 'stopped' : 'skipped'
  } catch {
    return 'skipped'
  }
}

/**
 * Request-isolate enqueue for self-host inventory after install (or any other
 * non-DO caller). Skips when the colocated daemon has not hello'd yet so a
 * fail-fast offline command cannot trip the 5-minute sweep throttle.
 *
 * Never call this from `onDaemonConnected` / Durable Object handlers — those
 * wait for {@link runSystemReconcileSweep}.
 */
export async function enqueueSystemReconcileIfConnected(
  db: Db,
  commandQueue: CommandQueue,
  serverId: string,
): Promise<EnqueueSystemReconcileIfConnectedResult> {
  const rows = await db.execute<{ is_connected: boolean }>(sql`
    SELECT is_connected
    FROM server
    WHERE id = ${serverId}::uuid
    LIMIT 1
  `)
  if (rows[0]?.is_connected !== true) {
    return { ok: false, reason: 'not_connected' }
  }
  return enqueueSystemReconcile(db, commandQueue, {
    serverId,
    actorType: 'system',
    actorId: serverId,
    action: 'reconcile',
  })
}

/**
 * Drift trigger: enqueue `system.reconcile` for connected servers whose
 * system-managed containers need observation and have no recent
 * system.reconcile command (5-minute throttle via the command table itself,
 * per server — not per environment, since one enqueue reconciles every
 * system environment on that server).
 *
 * Candidates include:
 * - hosting-ingress not running / missing a Docker id while hosting is
 *   enabled **and** something HTTP on this server needs the shared proxy
 *   (or the row was already observed — crash recovery)
 * - recently reconnected servers (`status_changed_at` within the throttle
 *   window) whose ingress was already observed, even when the row still
 *   says `running` — disconnect only flips `server.is_connected`, so inventory
 *   can be stale after reconnect
 * - self-host (`turbopanel`) database/queue/analytics containers not running
 *   or missing a Docker id
 *
 * Never enqueue solely because hierarchy stamped a pending `-in` row —
 * bare server enroll / hosting-enabled inventory must not pull Traefik up.
 *
 * Enqueue stays outside Durable Object handlers: request isolates (install,
 * hosting PATCH / operate), Workers cron, and the Deno maintenance timer
 * (immediate tick on boot, then every cell-maintain interval).
 */
export async function runSystemReconcileSweep(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ budget?: number }> = {},
): Promise<{ enqueued: number }> {
  const budget = Math.min(
    Math.max(1, params.budget ?? SYSTEM_RECONCILE_SWEEP_CAP),
    SYSTEM_RECONCILE_SWEEP_CAP,
  )
  const throttleCutoff = new Date(
    Date.now() - SYSTEM_RECONCILE_MIN_INTERVAL_MS,
  ).toISOString()
  const selfHostComposeServiceNameList = sql.join(
    SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES.map((name) => sql`${name}`),
    sql.raw(', '),
  )

  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT DISTINCT srv.id AS server_id
    FROM server srv
    JOIN environment e ON e.server_id = srv.id
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    JOIN service s ON s.environment_id = e.id
    JOIN container c ON c.service_id = s.id AND c.ordinal = 1
    WHERE w.kind = ${WORKSPACE_KIND_TURBOPANEL}
      AND srv.is_connected = true
      AND (
        (
          p.metadata->>'component' = ${SYSTEM_HOSTING_INGRESS_COMPONENT}
          AND s.name = ${SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME}
          AND c.role = 'ingress'
          AND srv.options->'hosting'->>'enabled' = 'true'
          AND (
            -- First demand, crash recovery (already observed), or reconnect.
            EXISTS (
              SELECT 1
              FROM hosting h
              JOIN service hs ON hs.id = h.service_id
              JOIN environment he ON he.id = hs.environment_id
              WHERE he.server_id = srv.id
                AND COALESCE(h.options->>'protocol', 'http') = 'http'
                AND jsonb_typeof(h.options->'hostnames') = 'array'
                AND jsonb_array_length(h.options->'hostnames') > 0
            )
            OR c.container_id IS NOT NULL
            OR c.status = 'running'
          )
          AND (
            c.status <> 'running'
            OR c.container_id IS NULL
            OR srv.status_changed_at >= ${throttleCutoff}::timestamptz
          )
        )
        OR (
          p.metadata->>'component' = ${SYSTEM_SELF_HOST_COMPONENT}
          AND s.name IN (${selfHostComposeServiceNameList})
          AND c.role = 'turbopanel'
          AND (c.status <> 'running' OR c.container_id IS NULL)
        )
        OR (
          p.metadata->>'component' = ${SYSTEM_MANAGED_INGRESS_COMPONENT}
          AND s.name = ${SYSTEM_PROXYSQL_COMPOSE_SERVICE_NAME}
          AND c.role = 'ingress'
          AND EXISTS (
            SELECT 1
            FROM node mm
            WHERE mm.server_id = srv.id
          )
          AND (
            c.status <> 'running'
            OR c.container_id IS NULL
            OR srv.status_changed_at >= ${throttleCutoff}::timestamptz
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = 'system.reconcile'
          AND cmd.created_at >= ${throttleCutoff}::timestamptz
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)

  let enqueued = 0
  for (const row of candidates) {
    const result = await enqueueSystemReconcile(db, commandQueue, {
      serverId: row.server_id,
      actorType: 'system',
      actorId: row.server_id,
      action: 'reconcile',
    })
    if (result.ok) enqueued += 1
  }
  return { enqueued }
}
