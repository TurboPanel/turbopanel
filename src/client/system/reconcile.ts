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
import { ingressContainerNameFromService } from '../../lib/naming.ts'
import { WORKSPACE_KIND_SYSTEM } from '../../lib/db/workspace-kind.ts'
import {
  isSystemSelfHostComposeServiceName,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
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

type SystemReconcileEnvironmentEntry = {
  component: string | null
  hostingEnabled: boolean
  services: Array<{ serviceId: string; composeServiceName: string }>
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
        desired: entry.hostingEnabled ? 'present' : 'absent',
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
        role: 'system',
        desired: 'present',
      })
    }
    return components
  }

  return []
}

/**
 * Resolve every system-workspace environment pinned to this server (join
 * `project.metadata->>'component'` under a `workspace.kind='system'`
 * ancestor) and return one payload per environment. Desired state is
 * derived per environment:
 * - hosting-ingress from `server.options.hosting.enabled`
 * - self-host (`turbopanel`) components are always `'present'`
 *
 * Returns an empty array when no system hierarchy is provisioned for the
 * server yet.
 */
export async function buildSystemReconcilePayload(
  db: Db,
  params: Readonly<{ serverId: string }>,
): Promise<SystemReconcileCommandPayload[]> {
  const rows = await db.execute<
    SystemReconcileEnvironmentRow & { server_options: unknown }
  >(sql`
    SELECT
      e.id AS environment_id,
      p.metadata->>'component' AS project_component,
      s.id AS service_id,
      s.name AS name,
      srv.options AS server_options
    FROM environment e
    JOIN project p ON p.id = e.project_id
    JOIN workspace w ON w.id = p.workspace_id
    JOIN service s ON s.environment_id = e.id
    JOIN server srv ON srv.id = e.server_id
    WHERE e.server_id = ${params.serverId}::uuid
      AND w.kind = ${WORKSPACE_KIND_SYSTEM}
    ORDER BY e.id, s.name
  `)

  const byEnvironment = new Map<string, SystemReconcileEnvironmentEntry>()
  for (const row of rows) {
    let entry = byEnvironment.get(row.environment_id)
    if (!entry) {
      entry = {
        component: row.project_component,
        hostingEnabled:
          parseServerOptions(row.server_options)?.hosting?.enabled === true,
        services: [],
      }
      byEnvironment.set(row.environment_id, entry)
    }
    entry.services.push({
      serviceId: row.service_id,
      composeServiceName: row.name,
    })
  }

  const payloads: SystemReconcileCommandPayload[] = []
  for (const [environmentId, entry] of byEnvironment) {
    const components = buildSystemReconcileComponents(entry)
    if (components.length === 0) continue
    payloads.push({ environmentId, action: 'reconcile', components })
  }
  return payloads
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
 * Drift trigger: enqueue `system.reconcile` for connected servers whose
 * system-managed containers need observation and have no recent
 * system.reconcile command (5-minute throttle via the command table itself,
 * per server — not per environment, since one enqueue reconciles every
 * system environment on that server).
 *
 * Candidates include:
 * - hosting-ingress not running or missing a Docker id (stale / never
 *   observed) while hosting is enabled
 * - recently reconnected servers (`status_changed_at` within the throttle
 *   window), even when the ingress row still says `running` — disconnect
 *   only flips `server.connected`, so inventory can be stale after reconnect
 * - self-host (`turbopanel`) database/queue/analytics containers not running
 *   or missing a Docker id
 *
 * Enqueue stays outside Durable Object handlers (cron / Deno timer only).
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
    WHERE w.kind = ${WORKSPACE_KIND_SYSTEM}
      AND srv.connected = true
      AND (
        (
          p.metadata->>'component' = ${SYSTEM_HOSTING_INGRESS_COMPONENT}
          AND s.name = ${SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME}
          AND c.role = 'ingress'
          AND srv.options->'hosting'->>'enabled' = 'true'
          AND (
            c.status <> 'running'
            OR c.container_id IS NULL
            OR srv.status_changed_at >= ${throttleCutoff}::timestamptz
          )
        )
        OR (
          p.metadata->>'component' = ${SYSTEM_SELF_HOST_COMPONENT}
          AND s.name IN (${selfHostComposeServiceNameList})
          AND c.role = 'system'
          AND (c.status <> 'running' OR c.container_id IS NULL)
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
