/**
 * Refuse a remote binding when the app host has no private path to the
 * database host. Neighbours already map a missing endpoint to 422
 * `binding_endpoint_unavailable`; this adds the plain-words fix.
 */

import type { Db } from '../../db/connection.ts'
import { isPrivateEndpointError, resolvePrivateEndpoint } from '../net/private-endpoint.ts'
import { isPrepareError, resolveMemberPrivateBindAddress } from '../managed/apply-prepare.ts'
import { listManagedMembers } from '../managed/members.ts'
import { hasRemoteConsumerServers } from './remote-consumers.ts'

export const BINDING_ENDPOINT_UNAVAILABLE_ERROR = 'binding_endpoint_unavailable'

export const BINDING_NO_PRIVATE_PATH_MESSAGE =
  "The server this app runs on cannot reach the database's server over a private network yet. Place both servers in the same datacenter or connect them on a private mesh, then try again."

export const BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE =
  'The server this app runs on cannot use the private address the database would publish for this cluster. Place both servers on the same private network path, then try again.'

export type BindingReachError = {
  error: typeof BINDING_ENDPOINT_UNAVAILABLE_ERROR
  message: string
}

async function consumerCanDialPublishedBind(
  db: Db,
  fromServerId: string,
  memberServerId: string,
  bind: Readonly<{ address: string; transport: string }>
): Promise<boolean> {
  const resolved = await resolvePrivateEndpoint(db, {
    fromServerId,
    toServerId: memberServerId,
    purpose: 'client-backend',
  })
  if (isPrivateEndpointError(resolved)) return false
  if (resolved.transport === 'local') return true
  return resolved.address === bind.address && resolved.transport === bind.transport
}

/**
 * When the app is on another host than every cluster member, that host must
 * already have a private path to each member. Co-resident apps skip this.
 *
 * Uses the same peer-first private-listener bind as `managed.apply` prepare, so
 * create is refused when apply would skip the consumer with a log.
 */
export async function remoteBindingReachError(
  db: Db,
  params: Readonly<{
    managedId: string
    consumerServerIds: readonly string[]
  }>
): Promise<BindingReachError | null> {
  const members = await listManagedMembers(db, params.managedId)
  const memberServerIds = members.map((row) => row.serverId)
  if (memberServerIds.length === 0) return null
  if (!hasRemoteConsumerServers(memberServerIds, params.consumerServerIds)) {
    return null
  }

  const memberServerIdSet = new Set(memberServerIds)
  const remoteConsumers = params.consumerServerIds.filter(
    (id) => id.length > 0 && !memberServerIdSet.has(id)
  )

  for (const member of members) {
    const publishedBind = await resolveMemberPrivateBindAddress(
      db,
      member,
      members,
      params.consumerServerIds
    )
    if (isPrepareError(publishedBind)) {
      return {
        error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
        message: BINDING_NO_PRIVATE_PATH_MESSAGE,
      }
    }

    if (publishedBind) {
      for (const fromServerId of remoteConsumers) {
        const canDial = await consumerCanDialPublishedBind(
          db,
          fromServerId,
          member.serverId,
          publishedBind
        )
        if (!canDial) {
          return {
            error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
            message: BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE,
          }
        }
      }
      continue
    }

    for (const fromServerId of remoteConsumers) {
      const resolved = await resolvePrivateEndpoint(db, {
        fromServerId,
        toServerId: member.serverId,
        purpose: 'client-backend',
      })
      if (isPrivateEndpointError(resolved)) {
        return {
          error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
          message: BINDING_NO_PRIVATE_PATH_MESSAGE,
        }
      }
    }
  }
  return null
}
