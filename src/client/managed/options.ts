import type { ManagedEngineSpec } from '../../lib/managed/index.ts'
import type { ManagedSettings } from '../../lib/managed/settings.ts'

/** Bounded list — oldest entries drop off once retention pruning removes them. */
const MAX_BACKUP_RECORDS = 200
const CHECKSUM_SHA256_RE = /^[a-f0-9]{64}$/
/** Mirrors the daemon `SAFE_MANAGED_ID_RE` (backupId becomes a filename). */
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]+$/

export type ManagedBackupRecord = {
  id: string
  createdAt: string
  sizeBytes: number
  checksum: string
  database?: string
  path: string
}

export type ManagedRowOptions = {
  settings: ManagedSettings
  databases: string[]
  backups: ManagedBackupRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateBackupRecord(value: unknown): ManagedBackupRecord | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    !SAFE_BACKUP_ID_RE.test(value.id) ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length === 0 ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isFinite(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.checksum !== 'string' ||
    !CHECKSUM_SHA256_RE.test(value.checksum) ||
    typeof value.path !== 'string' ||
    value.path.length === 0
  ) {
    return null
  }
  const record: ManagedBackupRecord = {
    id: value.id,
    createdAt: value.createdAt,
    sizeBytes: value.sizeBytes,
    checksum: value.checksum,
    path: value.path,
  }
  if (value.database !== undefined) {
    if (typeof value.database !== 'string' || value.database.length === 0) {
      return null
    }
    record.database = value.database
  }
  return record
}

function validateBackups(value: unknown): ManagedBackupRecord[] | null {
  // Absent key on existing rows (added after backups shipped) → `[]`.
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (value.length > MAX_BACKUP_RECORDS) return null
  const backups: ManagedBackupRecord[] = []
  for (const entry of value) {
    const record = validateBackupRecord(entry)
    if (record === null) return null
    backups.push(record)
  }
  return backups
}

function validateDatabaseNames(
  spec: ManagedEngineSpec,
  names: unknown,
): string[] | null {
  if (!Array.isArray(names)) return null
  const { pattern, maxLength } = spec.userOperations.identifier
  const validated: string[] = []
  for (const entry of names) {
    if (typeof entry !== 'string') return null
    const trimmed = entry.trim()
    if (trimmed.length === 0 || trimmed.length > maxLength || !pattern.test(trimmed)) {
      return null
    }
    validated.push(trimmed)
  }
  return validated
}

export function parseManagedRowOptions(
  spec: ManagedEngineSpec,
  value: unknown,
): ManagedRowOptions | null {
  if (!isRecord(value)) return null

  const settings = spec.parseSettings(value.settings)
  if (settings === null) return null

  const databases = validateDatabaseNames(spec, value.databases)
  if (databases === null) return null

  const backups = validateBackups(value.backups)
  if (backups === null) return null

  return { settings, databases, backups }
}

export function writeManagedRowOptions(options: ManagedRowOptions): Record<string, unknown> {
  return {
    settings: options.settings,
    databases: options.databases,
    backups: options.backups,
  }
}
