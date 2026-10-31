/**
 * Refuse a remote binding when the app host has no private path to the
 * database host. Neighbours already map a missing endpoint to 422
 * `binding_endpoint_unavailable`; this adds the plain-words fix.
 */

import type { Db } from '../../db/connection.ts'
import { isPrivateEndpointError, resolvePrivateEndpoint } from '../net/private-endpoint.ts'
import { isPrepareError, resolveMemberPrivateBindAddress } from '../managed/apply-prepare.ts'
import { type ManagedMemberRow, listManagedMembers } from '../managed/members.ts'
import { placementNeedsHealthyFabric } from '../managed/routes-helpers.ts'
import { hasRemoteConsumerServers } from './remote-consumers.ts'

export const BINDING_ENDPOINT_UNAVAILABLE_ERROR = 'binding_endpoint_unavailable'

export const BINDING_NO_PRIVATE_PATH_MESSAGE =
  "The server this app runs on cannot reach the database's server over a private network yet. Place both servers in the same datacenter or connect them on a private mesh, then try again."

export const BINDING_UNTRUSTED_NEEDS_FABRIC_MESSAGE =
  "The only datacenter the app's server and the database's server share is marked untrusted, and TurboFabric is not carrying traffic between them right now. Check that TurboFabric is on and healthy for both servers, or mark the datacenter trusted, then try again."

export const BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE =
  'The server this app runs on cannot use the private address the database would publish for this cluster. Place both servers on the same private network path, then try again.'

/** Extra detail on the refusal; older clients ignore it and show the message. */
export const BINDING_REASON_UNTRUSTED_NEEDS_FABRIC = 'untrusted_network_needs_fabric'

export type BindingReachError = {
  error: typeof BINDING_ENDPOINT_UNAVAILABLE_ERROR
  message: string
  reason?: typeof BINDING_REASON_UNTRUSTED_NEEDS_FABRIC
}

async function consumerCanDialPublishedBind(
  db: Db,
  fromServerId: string,
  memberServerId: string,
  bind: Readonly<{ address: string; transport: string }>
): Promise<'ok' | 'unreachable' | 'untrusted'> {
  const resolved = await resolvePrivateEndpoint(db, {
    fromServerId,
    toServerId: memberServerId,
    purpose: 'client-backend',
  })
  if (isPrivateEndpointError(resolved)) return 'unreachable'
  // A new binding never rides the public address on an untrusted network.
  if (placementNeedsHealthyFabric(resolved)) return 'untrusted'
  const sameBind = resolved.address === bind.address && resolved.transport === bind.transport
  return resolved.transport === 'local' || sameBind ? 'ok' : 'unreachable'
}

function remoteConsumerPathMissingError(message: string): BindingReachError {
  return { error: BINDING_ENDPOINT_UNAVAILABLE_ERROR, message }
}

function untrustedNeedsFabricError(): BindingReachError {
  return {
    error: BINDING_ENDPOINT_UNAVAILABLE_ERROR,
    message: BINDING_UNTRUSTED_NEEDS_FABRIC_MESSAGE,
    reason: BINDING_REASON_UNTRUSTED_NEEDS_FABRIC,
  }
}

async function untrustedPairError(
  db: Db,
  member: ManagedMemberRow,
  remoteConsumers: readonly string[]
): Promise<BindingReachError | null> {
  for (const fromServerId of remoteConsumers) {
    const pair = await resolvePrivateEndpoint(db, {
      fromServerId,
      toServerId: member.serverId,
      purpose: 'client-backend',
    })
    if (isPrivateEndpointError(pair) && pair.kind === 'untrusted_network_needs_fabric') {
      return untrustedNeedsFabricError()
    }
  }
  return null
}

async function remoteConsumersReachMember(
  db: Db,
  member: ManagedMemberRow,
  members: readonly ManagedMemberRow[],
  remoteConsumers: readonly string[],
  consumerServerIds: readonly string[]
): Promise<BindingReachError | null> {
  // The untrusted-network rule wins over a generic missing path, whether or
  // not the database publishes a listener.
  const untrusted = await untrustedPairError(db, member, remoteConsumers)
  if (untrusted) return untrusted

  const publishedBind = await resolveMemberPrivateBindAddress(
    db,
    member,
    members,
    consumerServerIds
  )
  if (isPrepareError(publishedBind)) {
    return remoteConsumerPathMissingError(BINDING_NO_PRIVATE_PATH_MESSAGE)
  }

  if (publishedBind) {
    for (const fromServerId of remoteConsumers) {
      const canDial = await consumerCanDialPublishedBind(
        db,
        fromServerId,
        member.serverId,
        publishedBind
      )
      if (canDial === 'untrusted') {
        return untrustedNeedsFabricError()
      }
      if (canDial === 'unreachable') {
        return remoteConsumerPathMissingError(BINDING_PUBLISHED_LISTENER_UNREACHABLE_MESSAGE)
      }
    }
    return null
  }

  for (const fromServerId of remoteConsumers) {
    const resolved = await resolvePrivateEndpoint(db, {
      fromServerId,
      toServerId: member.serverId,
      purpose: 'client-backend',
    })
    if (isPrivateEndpointError(resolved)) {
      return remoteConsumerPathMissingError(BINDING_NO_PRIVATE_PATH_MESSAGE)
    }
  }
  return null
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
    const denied = await remoteConsumersReachMember(
      db,
      member,
      members,
      remoteConsumers,
      params.consumerServerIds
    )
    if (denied) return denied
  }
  return null
}
