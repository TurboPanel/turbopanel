/**
 * Database access for the firewall model: operator-typed rules (`edict`) and
 * per-server state (`bulwark`). Nothing here sends anything to a host.
 */

import { and, asc, count, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { bulwark, edict, organization, server } from '../../db/schema.ts'
import type { EdictValues } from './edict-input.ts'
import {
  type FirewallOrgPolicy,
  type FirewallPolicyPatch,
  mergeFirewallPolicyIntoOptions,
  parseFirewallOrgPolicy,
} from './policy.ts'
import {
  type FirewallModeValue,
  type FirewallStateValue,
  MAX_FIREWALL_RULES_PER_ORG,
} from './vocabulary.ts'

export type EdictRecord = typeof edict.$inferSelect
export type BulwarkRecord = typeof bulwark.$inferSelect

/** What a server reports before any bulwark row exists: observe, nothing sent. */
export type BulwarkView = {
  serverId: string
  mode: FirewallModeValue
  generation: number
  lastDigest: string | null
  lastResult: unknown
  state: FirewallStateValue
  deadlineAt: string | null
  lastAppliedAt: string | null
  confirmedAt: string | null
}

export class EdictLimitError extends Error {
  constructor() {
    super(`an organization may have at most ${MAX_FIREWALL_RULES_PER_ORG} firewall rules`)
    this.name = 'EdictLimitError'
  }
}

export async function readOrganizationFirewallPolicy(
  db: Db,
  organizationId: string
): Promise<FirewallOrgPolicy | null> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row ? parseFirewallOrgPolicy(row.options) : null
}

export async function updateOrganizationFirewallPolicy(
  db: Db,
  organizationId: string,
  patch: FirewallPolicyPatch
): Promise<FirewallOrgPolicy | null> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
      .limit(1)
    if (!row) return null
    const options = mergeFirewallPolicyIntoOptions(row.options, patch)
    await tx.update(organization).set({ options }).where(eq(organization.id, organizationId))
    return parseFirewallOrgPolicy(options)
  })
}

/** Rules of one organization, oldest first; optionally only those that apply to one server. */
export async function listEdicts(
  db: Db,
  organizationId: string,
  serverId?: string
): Promise<EdictRecord[]> {
  const scope = serverId ? or(isNull(edict.serverId), eq(edict.serverId, serverId)) : undefined
  return await db
    .select()
    .from(edict)
    .where(and(eq(edict.organizationId, organizationId), scope))
    .orderBy(asc(edict.createdAt), asc(edict.id))
}

export async function findEdict(
  db: Db,
  organizationId: string,
  edictId: string
): Promise<EdictRecord | null> {
  const [row] = await db
    .select()
    .from(edict)
    .where(and(eq(edict.id, edictId), eq(edict.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/** A server of this organization, or null: the check that keeps a rule from pointing at another org's server. */
export async function serverBelongsToOrganization(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  return row !== undefined
}

/**
 * Insert a rule, refusing past {@link MAX_FIREWALL_RULES_PER_ORG}. The count and
 * the insert share one transaction with the organization row locked, so two
 * concurrent creates cannot both slip under the cap.
 */
export async function createEdict(
  db: Db,
  organizationId: string,
  createdBy: string,
  values: EdictValues
): Promise<EdictRecord> {
  return await db.transaction(async (tx) => {
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
    const [{ total }] = await tx
      .select({ total: count() })
      .from(edict)
      .where(eq(edict.organizationId, organizationId))
    if (total >= MAX_FIREWALL_RULES_PER_ORG) throw new EdictLimitError()
    const [row] = await tx
      .insert(edict)
      .values({ ...values, organizationId, createdBy })
      .returning()
    return row!
  })
}

export async function updateEdict(
  db: Db,
  organizationId: string,
  edictId: string,
  values: Partial<EdictValues>
): Promise<EdictRecord | null> {
  const [row] = await db
    .update(edict)
    .set(values)
    .where(and(eq(edict.id, edictId), eq(edict.organizationId, organizationId)))
    .returning()
  return row ?? null
}

export async function deleteEdict(
  db: Db,
  organizationId: string,
  edictId: string
): Promise<boolean> {
  const rows = await db
    .delete(edict)
    .where(and(eq(edict.id, edictId), eq(edict.organizationId, organizationId)))
    .returning({ id: edict.id })
  return rows.length > 0
}

export function toBulwarkView(serverId: string, row: BulwarkRecord | undefined): BulwarkView {
  if (!row) {
    return {
      serverId,
      mode: 'observe',
      generation: 0,
      lastDigest: null,
      lastResult: null,
      state: 'idle',
      deadlineAt: null,
      lastAppliedAt: null,
      confirmedAt: null,
    }
  }
  return {
    serverId,
    mode: row.mode as FirewallModeValue,
    generation: row.generation,
    lastDigest: row.lastDigest,
    lastResult: row.lastResult,
    state: row.state as FirewallStateValue,
    deadlineAt: row.deadlineAt,
    lastAppliedAt: row.lastAppliedAt,
    confirmedAt: row.confirmedAt,
  }
}

export async function readBulwark(db: Db, serverId: string): Promise<BulwarkView> {
  const [row] = await db.select().from(bulwark).where(eq(bulwark.serverId, serverId)).limit(1)
  return toBulwarkView(serverId, row)
}

/**
 * Set a server's mode, creating its row on first use. Changing the mode is a
 * change to the desired state, so the generation rises. The increment happens
 * in the database (`generation + 1`), so concurrent changes each get their own
 * number and the counter never goes backwards.
 */
export async function setBulwarkMode(
  db: Db,
  serverId: string,
  mode: FirewallModeValue
): Promise<BulwarkView> {
  const [row] = await db
    .insert(bulwark)
    .values({ serverId, mode, generation: 1 })
    .onConflictDoUpdate({
      target: bulwark.serverId,
      set: { mode, generation: sql`${bulwark.generation} + 1` },
    })
    .returning()
  return toBulwarkView(serverId, row)
}

/**
 * Take the next generation for a server whose desired ruleset changed (a rule
 * edit, a policy edit). Stage 4 calls this when it builds a push; the row is
 * created in `observe` if it did not exist.
 */
export async function nextBulwarkGeneration(db: Db, serverId: string): Promise<number> {
  const [row] = await db
    .insert(bulwark)
    .values({ serverId, generation: 1 })
    .onConflictDoUpdate({
      target: bulwark.serverId,
      set: { generation: sql`${bulwark.generation} + 1` },
    })
    .returning({ generation: bulwark.generation })
  return row!.generation
}
