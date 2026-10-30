import { resolveColocatedServerIdSet } from '../client/servers/colocated.ts'
import type { DaemonMessage } from '../contracts/cell-protocol.ts'
import type { Db } from '../db/connection.ts'
import { recordInstanceAcmeIssuance } from '../features/install/instance-hostnames.ts'
import { logWarn } from '../lib/logger.ts'

export type InstanceAcmeIssuanceMessage = Extract<
  DaemonMessage,
  { type: 'instance-acme-issuance-event' }
>

/**
 * Record an instance ACME result, but only from a server that runs this
 * control plane. Only that daemon is sent `instanceAcme` (`public-urls-update`
 * goes to the co-located server), yet any enrolled daemon can send the frame,
 * and the row it writes is the panel's own certificate state: a stray or
 * hostile host could otherwise clear a real error or show a false expiry.
 *
 * `includeSelfHostPin` is what makes this hold on Workers, where the
 * transport probes find nothing (`src/daemon/AGENTS.md`). Shared by both
 * inbound paths (`deno-ws.ts`, `cell/do.ts`). Returns whether it recorded.
 */
export async function recordInstanceAcmeIssuanceFromServer(
  db: Db,
  serverId: string,
  message: InstanceAcmeIssuanceMessage
): Promise<boolean> {
  const servesInstance = await resolveColocatedServerIdSet(db, undefined, [serverId], {
    includeSelfHostPin: true,
  })
  if (!servesInstance.has(serverId)) {
    logWarn(
      'instance-acme',
      `dropped instance-acme-issuance-event from server ${serverId}: it does not run this control plane`
    )
    return false
  }
  await recordInstanceAcmeIssuance(db, {
    hostname: message.hostname,
    ok: message.ok,
    at: message.at,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.notAfter ? { notAfter: message.notAfter } : {}),
  })
  return true
}
