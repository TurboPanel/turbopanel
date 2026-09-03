/**
 * Reconnect-time hardware-profile replay.
 *
 * `PUT /servers/:id/metrics/hardware-profile` (metrics-routes.ts) persists
 * `server.metadata.hardwareProfile` as the source of truth and best-effort
 * pushes a `metrics-sensor-overrides-update` envelope to the daemon when it
 * is connected. When the daemon is offline at save time, nothing re-sends
 * that profile once it reconnects — the daemon-side cache
 * (`<daemonStateDir>/metrics/hardware-profile.json`, see turbopaneld's
 * `metrics/collector/sensors/overrides.ts`) stays stale until an operator
 * re-saves.
 *
 * This sweep closes that gap. Like `runSystemReconcileSweep`
 * (`../system/reconcile.ts`), it must never be called from
 * `onDaemonConnected` / Durable Object handlers — see that file's
 * `enqueueSystemReconcileIfConnected` doc comment and
 * `src/client/system/AGENTS.md`. It runs from the same safe, non-DO
 * contexts: the Workers cron tick (`runQueuedCronSweeps` in
 * `../../daemon/cell/offline-sweep.ts`) and the Deno maintenance timer
 * (`deno-server.ts`).
 *
 * Dedup: `system.reconcile` throttles sweep-driven enqueues with a
 * `NOT EXISTS` against the `command` table, because that pipeline persists
 * a row per enqueue. `metrics-sensor-overrides-update` instead goes
 * straight to the connected daemon cell (`registry.getCell(serverId)
 * .enqueue(...)`, same as the eager push) with no queue-table row to dedup
 * against. So this sweep stamps its own marker,
 * `server.metadata.hardwareProfileReplayedAt`, after a successful enqueue,
 * and only treats a server as a candidate when that marker is missing or
 * older than the server's current `status_changed_at`. That directly
 * expresses "replay once per connection" instead of approximating it with
 * a rolling time window, so it doesn't matter how often the sweep ticks or
 * how long a server has been online — once replayed for the current
 * connection, it drops out of the candidate set until the next reconnect
 * bumps `status_changed_at` again. A failed enqueue never stamps the
 * marker, so the next tick retries — matching the eager push's best-effort
 * (swallowed-error) handling.
 *
 * Servers with no `hardwareProfile` in metadata are skipped: a daemon that
 * has never received an override write already defaults to `{}`
 * (`resolveHardwareProfile` in turbopaneld returns `{}` for a missing
 * file), so replaying `{}` there would be a pure no-op. Known gap: clearing
 * a profile (not just editing it) deletes the `hardwareProfile` key from
 * metadata entirely (see the PUT handler), so if that clear happens while
 * the daemon is offline, this sweep has no record that a clearing push is
 * owed — a daemon that cached the old profile keeps applying it until an
 * operator re-saves. That's a pre-existing gap in the offline-clear path,
 * not something this replay introduces; left as a follow-up rather than
 * widened here.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { parseServerHardwareProfile } from '../../lib/db/server-metadata.ts'

const HARDWARE_PROFILE_REPLAY_SWEEP_CAP = 100

type HardwareProfileReplayCandidateRow = {
  server_id: string
  hardware_profile: unknown
}

export async function runHardwareProfileReplaySweep(
  db: Db,
  registry: DaemonCellRegistry,
  params: Readonly<{ budget?: number }> = {},
): Promise<{ enqueued: number }> {
  const budget = Math.min(
    Math.max(1, params.budget ?? HARDWARE_PROFILE_REPLAY_SWEEP_CAP),
    HARDWARE_PROFILE_REPLAY_SWEEP_CAP,
  )

  const candidates = await db.execute<HardwareProfileReplayCandidateRow>(sql`
    SELECT srv.id AS server_id, srv.metadata->'hardwareProfile' AS hardware_profile
    FROM server srv
    WHERE srv.is_connected = true
      AND srv.metadata->'hardwareProfile' IS NOT NULL
      AND (
        srv.metadata->>'hardwareProfileReplayedAt' IS NULL
        OR (srv.metadata->>'hardwareProfileReplayedAt')::timestamptz < srv.status_changed_at
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)

  let enqueued = 0
  for (const row of candidates) {
    const serverId = row.server_id
    const profile = parseServerHardwareProfile(row.hardware_profile)
    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'metrics-sensor-overrides-update',
      deliveryId: generateDeliveryId(),
      requestId,
      overrides: profile ?? {},
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'metrics-sensor-overrides-update',
    })
    try {
      await registry.getCell(serverId).enqueue(envelope)
      cellTrace('request-enqueued', {
        requestId,
        serverId,
        kind: 'metrics-sensor-overrides-update',
        deliveryId: envelope.deliveryId,
      })
      // Stamp only the replay marker, not the whole `metadata` column — the
      // daemon projects resources / docker / geo onto the same column
      // concurrently (see the PUT handler's identical jsonb_set discipline),
      // so a full read-modify-write here could drop a concurrent write.
      await db.execute(sql`
        UPDATE server
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{hardwareProfileReplayedAt}',
          ${JSON.stringify(new Date().toISOString())}::jsonb
        )
        WHERE id = ${serverId}::uuid
      `)
      enqueued += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'metrics-sensor-overrides-update',
        resultStatus: 'error',
        error: message,
      })
    }
  }
  return { enqueued }
}
