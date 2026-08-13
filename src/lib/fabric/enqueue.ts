/**
 * Enqueue `server.fabric.reconcile` for TurboFabric relays.
 */

import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { createCommandRecord, transitionCommand } from '../db/command-records.ts'
import {
  buildFabricReconcilePayload,
  getFabricById,
  listFabricRelays,
  type FabricRecord,
} from '../db/fabric-records.ts'
import type { FabricReconcileCommandPayload } from '../commands/schemas.ts'

export type FabricEnqueueResult = {
  serverId: string
  commandId?: string
  status: 'queued' | 'failed' | 'skipped'
  error?: string
}

async function enqueueOne(params: {
  db: Db
  commandQueue: CommandQueue
  actorType: string
  actorId: string
  serverId: string
  payload: FabricReconcileCommandPayload
  expiresAt: string
}): Promise<FabricEnqueueResult> {
  try {
    const record = await createCommandRecord(params.db, {
      serverId: params.serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      type: 'server.fabric.reconcile',
      payload: params.payload,
      expiresAt: params.expiresAt,
    })
    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: params.serverId,
      type: 'server.fabric.reconcile',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    try {
      await params.commandQueue.enqueue(envelope)
    } catch {
      await transitionCommand(params.db, record.id, {
        status: 'failed',
        error: 'Command queue unavailable',
      })
      return {
        serverId: params.serverId,
        commandId: record.id,
        status: 'failed',
        error: 'Command queue unavailable',
      }
    }
    return { serverId: params.serverId, commandId: record.id, status: 'queued' }
  } catch {
    return { serverId: params.serverId, status: 'failed', error: 'enqueue_failed' }
  }
}

export async function enqueueFabricReconcileForServers(params: {
  db: Db
  commandQueue: CommandQueue
  actorType: string
  actorId: string
  fabric: FabricRecord | null
  serverIds: readonly string[]
  enabled: boolean
}): Promise<FabricEnqueueResult[]> {
  const expiresAt = new Date(Date.now() + 300_000).toISOString()
  const results: FabricEnqueueResult[] = []
  for (const serverId of params.serverIds) {
    let payload: FabricReconcileCommandPayload = { enabled: false }
    if (params.enabled) {
      if (!params.fabric) {
        results.push({ serverId, status: 'skipped' })
        continue
      }
      const built = await buildFabricReconcilePayload(params.db, {
        fabric: params.fabric,
        serverId,
      })
      if (!built) {
        results.push({ serverId, status: 'skipped' })
        continue
      }
      payload = built
    }
    results.push(
      await enqueueOne({
        db: params.db,
        commandQueue: params.commandQueue,
        actorType: params.actorType,
        actorId: params.actorId,
        serverId,
        payload,
        expiresAt,
      }),
    )
  }
  return results
}

/**
 * After the first public key lands, re-enqueue reconcile so peers learn it.
 */
export async function maybeEnqueueFabricMeshComplete(params: {
  db: Db
  commandQueue: CommandQueue
  actorType: string
  actorId: string
  fabricId: string
  filledNullKey: boolean
}): Promise<void> {
  if (!params.filledNullKey) return
  const fabric = await getFabricById(params.db, params.fabricId)
  if (!fabric) return
  const relays = await listFabricRelays(params.db, fabric.id)
  await enqueueFabricReconcileForServers({
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    fabric,
    serverIds: relays.map((row) => row.serverId),
    enabled: true,
  })
}
