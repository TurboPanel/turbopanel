import { and, eq, inArray, notInArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import {
  DESCRIPTION_MAX_LENGTH,
  displayNameCodePointLength,
} from '../display-name-format.ts'
import { label } from './schema.ts'

const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_LABEL_KEY_LENGTH = 255
const MAX_LABELS_PER_SERVER = 64

type LabelDbRow = typeof label.$inferSelect

export type ServerLabelRecord = {
  id: string
  createdAt: string
  updatedAt: string
  serverId: string
  key: string
  value: string
}

export type ParsedServerLabel = {
  key: string
  value: string
}

export type ParseServerLabelResult =
  | { ok: true; labels: ParsedServerLabel[] }
  | { ok: false; error: string }

export function serializeServerLabel(row: LabelDbRow): ServerLabelRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverId: row.serverId,
    key: row.key,
    value: row.value,
  }
}

function sortLabelRecords(records: ServerLabelRecord[]): ServerLabelRecord[] {
  return [...records].sort((a, b) => a.key.localeCompare(b.key))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveLabelMap(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  if (isPlainObject(value.labels)) return value.labels
  return value
}

export function parseServerLabelInput(value: unknown): ParseServerLabelResult {
  const map = resolveLabelMap(value)
  if (!map) {
    return { ok: false, error: 'Labels must be an object of string keys to string values' }
  }

  const entries = Object.entries(map)
  if (entries.length > MAX_LABELS_PER_SERVER) {
    return { ok: false, error: `A server may have at most ${String(MAX_LABELS_PER_SERVER)} labels` }
  }

  const seen = new Set<string>()
  const labels: ParsedServerLabel[] = []
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== 'string') {
      return { ok: false, error: 'Labels must be an object of string keys to string values' }
    }
    const key = rawKey.trim()
    if (key.length < 1 || key.length > MAX_LABEL_KEY_LENGTH || !LABEL_KEY_RE.test(key)) {
      return { ok: false, error: `Label key "${rawKey}" is invalid` }
    }
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate label key "${key}"` }
    }
    if (displayNameCodePointLength(rawValue) > DESCRIPTION_MAX_LENGTH) {
      return { ok: false, error: `Label value for "${key}" exceeds ${String(DESCRIPTION_MAX_LENGTH)} characters` }
    }
    seen.add(key)
    labels.push({ key, value: rawValue })
  }

  return { ok: true, labels }
}

export async function listServerLabels(
  db: Db,
  serverId: string,
): Promise<ServerLabelRecord[]> {
  const rows = await db
    .select()
    .from(label)
    .where(eq(label.serverId, serverId))

  return sortLabelRecords(rows.map(serializeServerLabel))
}

export async function listServerLabelsForServers(
  db: Db,
  serverIds: readonly string[],
): Promise<Map<string, ServerLabelRecord[]>> {
  const result = new Map<string, ServerLabelRecord[]>()
  if (serverIds.length === 0) return result

  const rows = await db
    .select()
    .from(label)
    .where(inArray(label.serverId, [...serverIds]))

  for (const row of rows) {
    const record = serializeServerLabel(row)
    const list = result.get(record.serverId)
    if (list) {
      list.push(record)
    } else {
      result.set(record.serverId, [record])
    }
  }

  for (const [serverId, records] of result) {
    result.set(serverId, sortLabelRecords(records))
  }
  return result
}

export async function setServerLabels(
  db: Db,
  serverId: string,
  labels: readonly ParsedServerLabel[],
): Promise<ServerLabelRecord[]> {
  const now = nowIso()
  const keys = labels.map((item) => item.key)

  return db.transaction(async (tx) => {
    for (const item of labels) {
      await tx
        .insert(label)
        .values({
          serverId,
          key: item.key,
          value: item.value,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [label.serverId, label.key],
          set: {
            value: item.value,
            updatedAt: now,
          },
        })
    }

    if (keys.length === 0) {
      await tx.delete(label).where(eq(label.serverId, serverId))
    } else {
      await tx
        .delete(label)
        .where(and(eq(label.serverId, serverId), notInArray(label.key, keys)))
    }

    return listServerLabels(tx, serverId)
  })
}
