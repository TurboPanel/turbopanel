import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant } from '../../lib/db/schema.ts'
import {
  ACCESS_PROFILES,
  isAccessProfileKey,
  type AccessProfileKey,
  type PermissionKey,
} from './catalog.ts'

export type AccessRecord = {
  id: string
  subjectKind: 'user' | 'team' | 'organization'
  subjectId: string
  resourceId: string
  effect: 'allow' | 'deny'
  accessProfileKey: string | null
  permissionKey: string | null
}

type AtomicGrantRow = {
  id: string
  entityType: string
  entityId: string
  subjectType: string
  subjectId: string
  permission: string
  allowed: boolean
}

function permissionSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

/** Collapse atomic `grant` rows into legacy access API records. */
export function collapseAtomicGrants(rows: AtomicGrantRow[]): AccessRecord[] {
  const grouped = new Map<string, AtomicGrantRow[]>()

  for (const row of rows) {
    const key = [
      row.subjectType,
      row.subjectId,
      row.entityType,
      row.entityId,
      row.allowed ? 'allow' : 'deny',
    ].join('\0')
    const bucket = grouped.get(key) ?? []
    bucket.push(row)
    grouped.set(key, bucket)
  }

  const records: AccessRecord[] = []

  for (const group of grouped.values()) {
    const sample = group[0]!
    const permissions = group.map((row) => row.permission)
    let matchedProfile: AccessProfileKey | null = null

    for (const profileKey of Object.keys(ACCESS_PROFILES) as AccessProfileKey[]) {
      if (permissionSetsEqual(permissions, ACCESS_PROFILES[profileKey])) {
        matchedProfile = profileKey
        break
      }
    }

    if (matchedProfile) {
      records.push({
        id: sample.id,
        subjectKind: sample.subjectType as AccessRecord['subjectKind'],
        subjectId: sample.subjectId,
        resourceId: sample.entityId,
        effect: sample.allowed ? 'allow' : 'deny',
        accessProfileKey: matchedProfile,
        permissionKey: null,
      })
      continue
    }

    for (const row of group) {
      records.push({
        id: row.id,
        subjectKind: row.subjectType as AccessRecord['subjectKind'],
        subjectId: row.subjectId,
        resourceId: row.entityId,
        effect: row.allowed ? 'allow' : 'deny',
        accessProfileKey: null,
        permissionKey: row.permission,
      })
    }
  }

  return records
}

function findMatchingProfileKey(
  permissions: readonly string[],
): AccessProfileKey | null {
  for (const profileKey of Object.keys(ACCESS_PROFILES) as AccessProfileKey[]) {
    if (permissionSetsEqual(permissions, ACCESS_PROFILES[profileKey])) {
      return profileKey
    }
  }
  return null
}

/** Delete a legacy access row, expanding profile grants to all atomic rows. */
export async function revokeLegacyAccessGrant(db: Db, accessId: string): Promise<boolean> {
  const targetRows = await db
    .select({
      id: grant.id,
      entityType: grant.entityType,
      entityId: grant.entityId,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      permission: grant.permission,
      allowed: grant.allowed,
    })
    .from(grant)
    .where(eq(grant.id, accessId))
    .limit(1)

  const target = targetRows[0]
  if (!target) {
    return false
  }

  const siblingRows = await db
    .select({
      id: grant.id,
      permission: grant.permission,
    })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, target.entityType),
        eq(grant.entityId, target.entityId),
        eq(grant.subjectType, target.subjectType),
        eq(grant.subjectId, target.subjectId),
        eq(grant.allowed, target.allowed),
      ),
    )

  const profileKey = findMatchingProfileKey(siblingRows.map((row) => row.permission))
  const idsToDelete =
    profileKey && siblingRows.length === ACCESS_PROFILES[profileKey].length
      ? siblingRows.map((row) => row.id)
      : [target.id]

  await db.delete(grant).where(inArray(grant.id, idsToDelete))
  return true
}

export function mapEffectToAllowed(effect: 'allow' | 'deny'): boolean {
  return effect === 'allow'
}

export function isAccessProfileExpansion(
  accessProfileKey: string | undefined,
): accessProfileKey is AccessProfileKey {
  return typeof accessProfileKey === 'string' && isAccessProfileKey(accessProfileKey)
}

export function profilePermissions(profileKey: AccessProfileKey): readonly PermissionKey[] {
  return ACCESS_PROFILES[profileKey]
}
