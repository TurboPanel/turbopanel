/**
 * The edge go-live gate. An edge connection mode (a tunnel or a proxy in
 * front of the control plane) may be built and tried on a throwaway install,
 * but it is only switched on once a superadmin has confirmed that every
 * server trusts this control plane's key. The confirmation is the
 * `EDGE_GATE_CONFIRMED` setting. `TURBOPANEL_EDGE_GATE=closed` keeps the gate
 * shut whatever the setting says; no value opens it.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { setting } from '../../../db/schema.ts'

export const EDGE_GATE_SETTING_KEY = 'EDGE_GATE_CONFIRMED'
export const EDGE_GATE_ENV = 'TURBOPANEL_EDGE_GATE'

export type EdgeGate = {
  open: boolean
  /** Sentence case; set when the gate is shut. */
  reason?: string
  confirmedAt: string | null
  confirmedBy: string | null
  /** True when the host environment keeps the gate shut. */
  forcedClosed: boolean
}

type StoredGate = { confirmed: boolean; at: string | null; by: string | null }

const CLOSED_REASON =
  'Edge connection modes stay off until a superadmin confirms every server trusts this control plane.'
const FORCED_REASON = 'This host keeps edge connection modes off (TURBOPANEL_EDGE_GATE=closed).'

function readStored(value: unknown): StoredGate {
  if (typeof value !== 'object' || value === null) return { confirmed: false, at: null, by: null }
  const raw = value as Record<string, unknown>
  return {
    confirmed: raw.confirmed === true,
    at: typeof raw.at === 'string' ? raw.at : null,
    by: typeof raw.by === 'string' ? raw.by : null,
  }
}

/** Pure: the gate from the stored confirmation and the host environment. */
export function edgeGateFrom(stored: unknown, envValue: string | undefined): EdgeGate {
  const gate = readStored(stored)
  const forcedClosed = envValue?.trim().toLowerCase() === 'closed'
  const base = { confirmedAt: gate.at, confirmedBy: gate.by, forcedClosed }
  if (forcedClosed) return { ...base, open: false, reason: FORCED_REASON }
  if (!gate.confirmed) return { ...base, open: false, reason: CLOSED_REASON }
  return { ...base, open: true }
}

export async function readEdgeGate(
  db: Db,
  env: Record<string, string | undefined>
): Promise<EdgeGate> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, EDGE_GATE_SETTING_KEY))
    .limit(1)
  return edgeGateFrom(rows[0]?.value, env[EDGE_GATE_ENV])
}

/** Record or withdraw the confirmation. `by` is the superadmin's email, kept for the screen. */
export async function writeEdgeGate(
  db: Db,
  confirmed: boolean,
  by: string | null,
  at = new Date().toISOString()
): Promise<void> {
  const value: StoredGate = { confirmed, at, by }
  await db
    .insert(setting)
    .values({ key: EDGE_GATE_SETTING_KEY, value })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: at } })
}
