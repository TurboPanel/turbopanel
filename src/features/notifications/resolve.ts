/**
 * The resolution ladder: which preference row decides one copy of one event
 * for one person, and whether that copy goes out. Pure, so every case is
 * tested directly (`resolve.hostfree.test.ts`); the fan-out fetches the rows
 * once per event for every candidate and calls this per person and channel.
 *
 * Owner decisions (2026-11-06) that shape it: nothing is always on, and a
 * person with no rows hears nothing (the catalog level is `none` for every
 * topic). Organization policies are stored but not read yet.
 *
 * Most specific row wins, compared in this order:
 *   1. scope: a service, server or backup target, then environment, project,
 *      organization, and last the person's rule for every organization;
 *   2. subject: one topic, then one category, then every topic;
 *   3. target: one personal channel, then one channel kind, then every kind.
 * Scope beats subject on purpose: "deploys: none" everywhere plus "project
 * Checkout: all" means Checkout's deploys arrive. A row whose `endsAt` has
 * passed is ignored. The unique key on `preference` rules out ties except
 * between rows for two different resources of one event (`decidingRows`).
 */
import type { NotificationSeverity } from './events.ts'
import type { NotificationLevel, NotificationPreferenceKind } from './vocabulary.ts'

export type PreferenceRow = {
  id: string
  userId: string
  organizationId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
  channelId: string | null
  categoryCode: string | null
  topicCode: string | null
  kind: NotificationPreferenceKind | null
  level: NotificationLevel
  endsAt: string | null
}

/** Where an event happened, as far as preferences are concerned. */
export type EventScope = {
  organizationId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
  topicCode: string
  categoryCode: string
}

/** The copy being decided: a channel kind, and the personal channel when there is one. */
export type CopyTarget = {
  kind: NotificationPreferenceKind
  channelId: string | null
}

export type Resolution = {
  level: NotificationLevel
  /** The row that decided, or null when nothing matched and the catalog level applied. */
  source: PreferenceRow | null
}

const SEVERITY_FLOOR: Record<Exclude<NotificationLevel, 'none'>, number> = {
  all: 0,
  warning: 1,
  critical: 2,
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

/** True when a level lets an event of this severity through. */
export function levelAllows(level: NotificationLevel, severity: NotificationSeverity): boolean {
  if (level === 'none') return false
  return SEVERITY_RANK[severity] >= SEVERITY_FLOOR[level]
}

/** How specific a row's scope is: resource 5 … every organization 1. */
export function scopeDepth(row: PreferenceRow): number {
  if (row.serviceId || row.serverId || row.destinationId) return 5
  if (row.environmentId) return 4
  if (row.projectId) return 3
  if (row.organizationId) return 2
  return 1
}

function subjectDepth(row: PreferenceRow): number {
  if (row.topicCode) return 3
  if (row.categoryCode) return 2
  return 1
}

function targetDepth(row: PreferenceRow): number {
  if (row.channelId) return 3
  if (row.kind) return 2
  return 1
}

function specificity(row: PreferenceRow): number {
  return scopeDepth(row) * 100 + subjectDepth(row) * 10 + targetDepth(row)
}

function matchesId(rowValue: string | null, eventValue: string | null): boolean {
  return rowValue === null || rowValue === eventValue
}

/** True when the row applies to this event and copy at `nowMs`. */
export function rowMatches(
  row: PreferenceRow,
  scope: EventScope,
  target: CopyTarget,
  nowMs: number
): boolean {
  if (row.endsAt !== null && Date.parse(row.endsAt) <= nowMs) return false
  return (
    matchesId(row.organizationId, scope.organizationId) &&
    matchesId(row.projectId, scope.projectId) &&
    matchesId(row.environmentId, scope.environmentId) &&
    matchesId(row.serviceId, scope.serviceId) &&
    matchesId(row.serverId, scope.serverId) &&
    matchesId(row.destinationId, scope.destinationId) &&
    matchesId(row.topicCode, scope.topicCode) &&
    matchesId(row.categoryCode, scope.categoryCode) &&
    matchesId(row.channelId, target.channelId) &&
    matchesId(row.kind, target.kind)
  )
}

/**
 * Every matching row at the highest specificity. Usually one; an event that
 * names both a service and a server can match one row for each at the same
 * depth, and which of those `resolveLevel` returns depends on row order. The
 * unsubscribe covers all of them so the order cannot matter.
 */
export function decidingRows(
  rows: readonly PreferenceRow[],
  scope: EventScope,
  target: CopyTarget,
  nowMs: number
): PreferenceRow[] {
  let top: PreferenceRow[] = []
  let topRank = -1
  for (const row of rows) {
    if (!rowMatches(row, scope, target, nowMs)) continue
    const rank = specificity(row)
    if (rank > topRank) {
      top = [row]
      topRank = rank
    } else if (rank === topRank) {
      top.push(row)
    }
  }
  return top
}

/** The deciding row for one person's copy; `fallback` is the topic's catalog level. */
export function resolveLevel(
  rows: readonly PreferenceRow[],
  scope: EventScope,
  target: CopyTarget,
  nowMs: number,
  fallback: NotificationLevel = 'none'
): Resolution {
  let best: PreferenceRow | null = null
  let bestRank = -1
  for (const row of rows) {
    if (!rowMatches(row, scope, target, nowMs)) continue
    const rank = specificity(row)
    if (rank > bestRank) {
      best = row
      bestRank = rank
    }
  }
  return best ? { level: best.level, source: best } : { level: fallback, source: null }
}

/** Group rows by person, so the fan-out resolves each recipient over their own rows only. */
export function rowsByUser(rows: readonly PreferenceRow[]): Map<string, PreferenceRow[]> {
  const out = new Map<string, PreferenceRow[]>()
  for (const row of rows) {
    const list = out.get(row.userId)
    if (list) list.push(row)
    else out.set(row.userId, [row])
  }
  return out
}

/** The preference kind a channel's copies are decided by. */
export function preferenceKindForChannel(
  channelKind: 'email' | 'webhook' | 'slack' | 'discord' | 'telegram' | 'push'
): NotificationPreferenceKind {
  if (channelKind === 'slack' || channelKind === 'discord' || channelKind === 'telegram') {
    return 'chat'
  }
  return channelKind
}
