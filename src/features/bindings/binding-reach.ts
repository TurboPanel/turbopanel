/**
 * Refuse a remote binding when the app host has no private path to the
 * database host. Neighbours already map a missing endpoint to 422
 * `binding_endpoint_unavailable`; this adds the plain-words fix.
 */

import type { Db } from '../../db/connection.ts'
import { replica } from '../../db/schema.ts'
import { eq } from 'drizzle-orm'
import { isPrivateEndpointError, resolvePrivateEndpoint } from '../net/private-endpoint.ts'
import { hasRemoteConsumerServers } from './remote-consumers.ts'

export const BINDING_ENDPOINT_UNAVAILABLE_ERROR = 'binding_endpoint_unavailable'

export const BINDING_NO_PRIVATE_PATH_MESSAGE =
  "The server this app runs on cannot reach the database's server over a private network yet. Place both servers in the same datacenter or connect them on a private mesh, then try again."

export type BindingReachError = {
  error: typeof BINDING_ENDPOINT_UNAVAILABLE_ERROR
  message: string
}

/**
 * When the app is on another host than every cluster member, that host must
 * already have a private path to each member. Co-resident apps skip this.
 */
export async function remoteBindingReachError(
  db: Db,
  params: Readonly<{
    managedId: string
    consumerServerIds: readonly string[]
  }>
): Promise<BindingReachError | null> {
  const memberRows = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, params.managedId))
  const memberServerIds = memberRows.map((row) => row.serverId)
  if (memberServerIds.length === 0) return null
  if (!hasRemoteConsumerServers(memberServerIds, params.consumerServerIds)) {
    return null
  }

  const remoteConsumers = params.consumerServerIds.filter(
    (id) => id.length > 0 && !memberServerIds.includes(id)
  )
  for (const fromServerId of remoteConsumers) {
    for (const toServerId of memberServerIds) {
      const resolved = await resolvePrivateEndpoint(db, {
        fromServerId,
        toServerId,
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
