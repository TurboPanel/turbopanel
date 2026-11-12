/** Request parsing and names for admin tools. Pure: no I/O, so it runs host-free. */

import { ADMIN_TOOLS, type AdminToolId, isAdminToolId } from './templates.ts'
import type { AdminToolAccess } from './projects.ts'

export type AdminToolBody = {
  tool: AdminToolId
  hostname: string
  access: AdminToolAccess
}

export type AdminToolBodyResult =
  { ok: true; body: AdminToolBody } | { ok: false; error: string; message: string }

/** Reads `{ tool, hostname, access? }`; the default access is Database Admin. */
export function parseAdminToolBody(body: Record<string, unknown>): AdminToolBodyResult {
  const { tool, hostname, access } = body
  if (!isAdminToolId(tool)) {
    return {
      ok: false,
      error: 'admin_tool_unknown',
      message: 'Choose phpMyAdmin, Adminer or pgAdmin.',
    }
  }
  if (typeof hostname !== 'string' || hostname.trim() === '') {
    return {
      ok: false,
      error: 'invalid_hostname',
      message: 'Enter the hostname the tool answers on.',
    }
  }
  const chosen = access ?? 'admin'
  if (chosen !== 'admin' && chosen !== 'read-only') {
    return {
      ok: false,
      error: 'admin_tool_access_invalid',
      message: 'Access is Database Admin or Read-Only.',
    }
  }
  return { ok: true, body: { tool, hostname: hostname.trim().toLowerCase(), access: chosen } }
}

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SUFFIX_LENGTH = 6

/** `<tool>_<six random lowercase letters or digits>`; `random` is injected so tests stay fixed. */
export function adminToolLoginName(
  tool: AdminToolId,
  random: (max: number) => number = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max
): string {
  const suffix = Array.from(
    { length: SUFFIX_LENGTH },
    () => SUFFIX_ALPHABET[random(SUFFIX_ALPHABET.length)]
  ).join('')
  return `${tool}_${suffix}`
}

/** `<cluster project> <Tool label>`. */
export function adminToolProjectName(clusterName: string | null, label: string): string {
  const base = (clusterName ?? '').trim()
  return base ? `${base} ${label}` : label
}

/** First try as is, then ` 2`, ` 3` and so on. */
export function addAdminToolNameSuffix(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} ${attempt}`
}

export function adminToolLabel(tool: AdminToolId): string {
  return ADMIN_TOOLS[tool].label
}
