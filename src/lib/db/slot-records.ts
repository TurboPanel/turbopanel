import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { inetAddressToString } from '../ip-address.ts'
import { slot } from './schema.ts'

/**
 * Scheduled instances of a logical service. Row identity and `created_at`
 * survive a re-plan (upsert on `(service_id, slot)`). A slot whose `server_id`
 * is unchanged is rewritten only for `generation` (plus `desiredState` /
 * `updatedAt`) — this helper never re-homes a slot the caller did not move.
 * The planner owns movement decisions by passing a different `serverId`.
 */
export const SLOT_DESIRED_STATES = Object.freeze(
  ['running', 'stopped', 'removed'] as const,
)

export type SlotDesiredState = (typeof SLOT_DESIRED_STATES)[number]

type SlotDbRow = typeof slot.$inferSelect

export type SlotRecord = {
  id: string
  createdAt: string
  updatedAt: string
  metadata: unknown
  options: unknown
  environmentId: string
  serviceId: string
  serverId: string
  slot: number
  generation: number
  desiredState: SlotDesiredState
  /**
   * Cross-host address on a spanning compose network. A slot carries at most
   * one address (a service typically joins one spanning network per environment).
   */
  address: string | null
}

export type DesiredSlotInput = {
  serviceId: string
  serverId: string
  slot: number
  desiredState?: SlotDesiredState
  /** `null` clears a previously allocated spanning-network address. */
  address?: string | null
}

function isSlotDesiredState(value: string): value is SlotDesiredState {
  return (SLOT_DESIRED_STATES as readonly string[]).includes(value)
}

export function serializeSlot(row: SlotDbRow): SlotRecord {
  const desiredState = isSlotDesiredState(row.desiredState) ? row.desiredState : 'running'
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata ?? null,
    options: row.options ?? null,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    serverId: row.serverId,
    slot: row.slot,
    generation: row.generation,
    desiredState,
    address: inetAddressToString(row.address) ?? null,
  }
}

function sortSlots(records: SlotRecord[]): SlotRecord[] {
  return [...records].sort((a, b) => {
    const byService = a.serviceId.localeCompare(b.serviceId)
    if (byService !== 0) return byService
    return a.slot - b.slot
  })
}

function slotKey(serviceId: string, slot: number): string {
  return `${serviceId}:${String(slot)}`
}

type ReplaceEnvironmentSlotsParams = {
  environmentId: string
  generation: number
  slots: readonly DesiredSlotInput[]
}

/**
 * Sticky re-plan of scheduled instances. Standalone callers get a transaction;
 * deploy persistence passes an existing `tx` via {@link replaceEnvironmentSlotsInTx}.
 */
export async function replaceEnvironmentSlots(
  db: Db,
  params: ReplaceEnvironmentSlotsParams,
): Promise<void> {
  await db.transaction(async (tx) => {
    await replaceEnvironmentSlotsInTx(tx, params)
  })
}

/** Same writes as {@link replaceEnvironmentSlots} without opening a nested transaction. */
export async function replaceEnvironmentSlotsInTx(
  db: Db,
  params: ReplaceEnvironmentSlotsParams,
): Promise<void> {
  const now = nowIso()
  const desiredKeys = new Set(
    params.slots.map((item) => slotKey(item.serviceId, item.slot)),
  )

  const existing = await db
    .select({
      id: slot.id,
      serviceId: slot.serviceId,
      slot: slot.slot,
    })
    .from(slot)
    .where(eq(slot.environmentId, params.environmentId))

  for (const item of params.slots) {
    await db
      .insert(slot)
      .values({
        environmentId: params.environmentId,
        serviceId: item.serviceId,
        serverId: item.serverId,
        slot: item.slot,
        generation: params.generation,
        desiredState: item.desiredState ?? 'running',
        address: item.address ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [slot.serviceId, slot.slot],
        set: {
          serverId: item.serverId,
          generation: params.generation,
          desiredState: item.desiredState ?? 'running',
          address: item.address ?? null,
          updatedAt: now,
        },
      })
  }

  const staleIds = existing
    .filter((row) => !desiredKeys.has(slotKey(row.serviceId, row.slot)))
    .map((row) => row.id)
  if (staleIds.length === 0) return

  await db.delete(slot).where(inArray(slot.id, staleIds))
}

export async function listEnvironmentSlots(
  db: Db,
  environmentId: string,
  opts?: { generation?: number },
): Promise<SlotRecord[]> {
  const filter = opts?.generation === undefined ? eq(slot.environmentId, environmentId) : and(
    eq(slot.environmentId, environmentId),
    eq(slot.generation, opts.generation),
  )

  const rows = await db
    .select()
    .from(slot)
    .where(filter)
    .orderBy(slot.serviceId, slot.slot)

  return sortSlots(rows.map(serializeSlot))
}

export async function listSlotsForServer(
  db: Db,
  params: { serverId: string; environmentId?: string },
): Promise<SlotRecord[]> {
  const filter = params.environmentId === undefined ? eq(slot.serverId, params.serverId) : and(
    eq(slot.serverId, params.serverId),
    eq(slot.environmentId, params.environmentId),
  )

  const rows = await db
    .select()
    .from(slot)
    .where(filter)
    .orderBy(slot.serviceId, slot.slot)

  return sortSlots(rows.map(serializeSlot))
}
