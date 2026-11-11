/**
 * A daemon that already applied a higher table generation answers a table it
 * did not apply with a warning (`tunnel-table-generation-v1`). The panel sends
 * the organization's current generation, so this means the daemon holds a
 * higher number than the panel has: a stuck daemon. It is logged so it shows
 * in the logs; nothing else changes.
 */
import { compatLogWarn } from '../../lib/log-compat.ts'

const STALE_WARNING = /^tunnel table generation (\d+) is older than the one in place/

/** The daemon's warning for a table it left as it was because of its generation, or `undefined`. */
export function staleTunnelTableWarning(type: string, result: unknown): string | undefined {
  if (type !== 'server.tunnel.routes') return undefined
  const answer = result as { applied?: unknown; warnings?: unknown } | null
  if (answer?.applied !== false || !Array.isArray(answer.warnings)) return undefined
  return answer.warnings.find((w): w is string => typeof w === 'string' && STALE_WARNING.test(w))
}

/** The generation the daemon refused, read out of its warning. */
function refusedGeneration(warning: string): string {
  return STALE_WARNING.exec(warning)?.[1] ?? 'unknown'
}

/** Log a warning (command and server only) when the daemon refused a table as older than its own. */
export function noteStaleTunnelTable(
  record: { id: string; type: string; serverId: string },
  result: unknown
): void {
  const warning = staleTunnelTableWarning(record.type, result)
  if (warning === undefined) return
  compatLogWarn(
    'tunnel-sync',
    `server ${record.serverId}: command ${record.id}: the daemon kept its forwarding table and refused generation ${refusedGeneration(warning)}; it holds a higher generation than this control plane sent`
  )
}
