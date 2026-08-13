import type { FabricRecord } from '../../lib/db/fabric-records.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFabricPutBody(
  body: unknown,
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, enabled: body.enabled }
}

export function fabricSettingsResponse(record: FabricRecord | null): {
  enabled: boolean
  fabric?: { id: string; cidr: string }
} {
  if (!record) return { enabled: false }
  return {
    enabled: true,
    fabric: { id: record.id, cidr: record.cidr },
  }
}
