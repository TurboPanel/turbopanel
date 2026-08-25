/**
 * Fan-out `server.tls.trust.reconcile` so connected daemons receive a CA
 * bundle over the already-authenticated WSS session.
 *
 * Deno-only (reads the durable platform CA from disk). Callers must not import
 * this from the Workers graph.
 */

import type { Db } from '../db.ts'
import { listConnectedServerIdsFromProjection } from '../daemon/cell/postgres-projection.ts'
import type { CommandQueue } from '../lib/commands/queue.ts'
import { buildCommandEnqueueEnvelope } from '../client/servers/command-dispatch-helpers.ts'
import { createCommandRecord } from '../lib/db/command-records.ts'
import { parseCertificatePem } from '../lib/tls/parse.ts'
import { logWarn } from '../logger.ts'
import {
  resolveInstanceTlsCaServePath,
} from '../server-paths.ts'

const TLS_TRUST_TTL_MS = 300_000

export type EnqueuePlatformCaTrustReconcileParams = Readonly<{
  db: Db
  commandQueue: CommandQueue
  actorId: string
  nowMs?: number
  readBundle?: () => Promise<string>
  listServerIds?: (db: Db) => Promise<string[]>
  createCommand?: (
    db: Db,
    input: {
      serverId: string
      actorType: string
      actorId: string
      type: string
      payload: unknown
      expiresAt: string
    },
  ) => Promise<{ id: string; queuedAt: string | null; createdAt: string }>
}>

async function readPlatformCaBundle(): Promise<string> {
  const path = resolveInstanceTlsCaServePath()
  return await Deno.readTextFile(path)
}

export async function enqueuePlatformCaTrustReconcile(
  params: EnqueuePlatformCaTrustReconcileParams,
): Promise<{ enqueued: number }> {
  const bundlePem = await (params.readBundle ?? readPlatformCaBundle)()
  const parsed = await parseCertificatePem(bundlePem)
  const fingerprint = parsed.fingerprintSha256
  const serverIds = await (params.listServerIds ??
    listConnectedServerIdsFromProjection)(params.db)
  const expiresAt = new Date(
    (params.nowMs ?? Date.now()) + TLS_TRUST_TTL_MS,
  ).toISOString()

  let enqueued = 0
  for (const serverId of serverIds) {
    const record = await (params.createCommand ?? createCommandRecord)(params.db, {
      serverId,
      actorType: 'user',
      actorId: params.actorId,
      type: 'server.tls.trust.reconcile',
      payload: { bundlePem, fingerprint },
      expiresAt,
    })
    await params.commandQueue.enqueue(
      buildCommandEnqueueEnvelope({
        commandId: record.id,
        serverId,
        type: 'server.tls.trust.reconcile',
        queuedAt: record.queuedAt ?? record.createdAt,
      }),
    )
    enqueued += 1
  }
  return { enqueued }
}

export async function enqueuePlatformCaTrustReconcileBestEffort(
  params: EnqueuePlatformCaTrustReconcileParams,
): Promise<void> {
  try {
    const { enqueued } = await enqueuePlatformCaTrustReconcile(params)
    if (enqueued === 0) {
      logWarn(
        'tls-trust',
        'no connected servers to receive the platform CA bundle',
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logWarn(
      'tls-trust',
      `failed to fan out server.tls.trust.reconcile: ${message}`,
    )
  }
}
