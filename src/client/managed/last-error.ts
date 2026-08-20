import type { Db } from '../../db.ts'
import { listServerCommands } from '../../lib/db/command-records.ts'

const MANAGED_ENGINE_FAILURE_TYPES = new Set([
  'managed.apply',
  'managed.lifecycle',
  'managed.destroy',
  'managed.restore',
  'managed.promote',
  'managed.ha.failover',
])

const MANAGED_INGRESS_FAILURE_TYPE = 'managed.ingress.reconcile'

export type ManagedFailureCommand = {
  type: string
  status: string
  error: string | null
  payload: unknown
  createdAt?: string
}

export function mergeManagedFailureMessages(
  ...parts: ReadonlyArray<string | null | undefined>
): string | null {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const trimmed = part?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.length > 0 ? out.join('\n') : null
}

function commandManagedId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const id = (payload as { managedId?: unknown }).managedId
  return typeof id === 'string' ? id : null
}

function isFailedCommand(row: ManagedFailureCommand): boolean {
  return row.status === 'failed' || row.status === 'timed_out'
}

function hasCommandError(row: ManagedFailureCommand): boolean {
  return typeof row.error === 'string' && row.error.trim().length > 0
}

/**
 * Latest apply-family error for this cluster, plus the latest ingress
 * reconcile error (ProxySQL). Newest-first lists: `find` is the latest of
 * each kind. Ingress is server-scoped, not `managedId`-keyed.
 */
export function pickManagedFailureMessage(
  commands: readonly ManagedFailureCommand[],
  managedId: string,
): string | null {
  const newestFirst = [...commands].sort((a, b) =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  )
  const engine = newestFirst.find((row) =>
    isFailedCommand(row) &&
    hasCommandError(row) &&
    MANAGED_ENGINE_FAILURE_TYPES.has(row.type) &&
    commandManagedId(row.payload) === managedId
  )
  const latestIngress = newestFirst.find((row) =>
    row.type === MANAGED_INGRESS_FAILURE_TYPE
  )
  const ingressError =
    latestIngress && isFailedCommand(latestIngress) && hasCommandError(latestIngress)
      ? latestIngress.error
      : null
  return mergeManagedFailureMessages(engine?.error, ingressError)
}

export async function loadManagedStatusError(
  db: Db,
  input: {
    managedId: string
    status: string | null
    residualError: string | null
    serverIds: readonly (string | null | undefined)[]
  },
): Promise<string | null> {
  if (input.status !== 'failed') return null
  const serverIds = [...new Set(
    input.serverIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
  )].sort((a, b) => a.localeCompare(b))
  if (serverIds.length === 0) {
    return input.residualError
  }
  const lists = await Promise.all(
    serverIds.map((serverId) => listServerCommands(db, { serverId, limit: 20 })),
  )
  return mergeManagedFailureMessages(
    input.residualError,
    pickManagedFailureMessage(lists.flat(), input.managedId),
  )
}
