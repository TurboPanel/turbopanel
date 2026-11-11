/**
 * A daemon that already applied a higher table generation answers a table it
 * did not apply with a warning (`tunnel-table-generation-v1`). The panel sends
 * the organization's current generation, so this means the daemon holds a
 * higher number than the panel has: a stuck daemon. It is logged so it shows
 * in the logs, and the organization's generation is raised so it applies.
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

export type StaleTableHealPorts = {
  /** The organization of a server, or `undefined` when it is gone. */
  organizationOf: (serverId: string) => Promise<string | undefined>
  /** Raise the organization's generation; the new number, or `undefined` when raised too recently. */
  bump: (organizationId: string) => Promise<number | undefined>
  /** Send the server its table again (the normal sync path). */
  resend: (organizationId: string, serverId: string) => Promise<void>
}

/**
 * A daemon refused a table as older than its own: the stored number is behind
 * what the daemon applied (for example after a restore). Log it, raise the
 * organization's generation (at most once a minute per organization, so two
 * stuck daemons cannot loop) and send that server its table again so it applies.
 * Returns whether a table was requeued.
 */
export async function healStaleTunnelTable(
  record: { id: string; type: string; serverId: string },
  result: unknown,
  ports: StaleTableHealPorts
): Promise<boolean> {
  const warning = staleTunnelTableWarning(record.type, result)
  if (warning === undefined) return false
  compatLogWarn(
    'tunnel-sync',
    `server ${record.serverId}: command ${record.id}: the daemon kept its forwarding table and refused generation ${refusedGeneration(warning)}; it holds a higher generation than this control plane sent`
  )
  const organizationId = await ports.organizationOf(record.serverId)
  if (organizationId === undefined) return false
  const raised = await ports.bump(organizationId)
  if (raised === undefined) {
    compatLogWarn(
      'tunnel-sync',
      `organization ${organizationId}: the tunnel table generation was raised less than a minute ago; not raised again for server ${record.serverId}`
    )
    return false
  }
  compatLogWarn(
    'tunnel-sync',
    `organization ${organizationId}: tunnel table generation raised to ${raised}; sending server ${record.serverId} its table again`
  )
  await ports.resend(organizationId, record.serverId)
  return true
}
