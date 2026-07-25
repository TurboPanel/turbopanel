import { and, eq, or, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { network } from '../../lib/db/schema.ts'
import { readNetworkDockerNetworkName } from '../../lib/docker-network-name.ts'

export async function validateRegisteredExternalDockerNetworks(
  db: Db,
  organizationId: string,
  serverId: string,
  requiredNames: readonly string[],
): Promise<string[] | null> {
  if (requiredNames.length === 0) return null

  const rows = await db
    .select({
      serverId: network.serverId,
      options: network.options,
      metadata: network.metadata,
    })
    .from(network)
    .where(
      and(
        eq(network.organizationId, organizationId),
        eq(network.kind, 'docker'),
        or(isNull(network.serverId), eq(network.serverId, serverId)),
      ),
    )

  const registered = new Set<string>()
  for (const row of rows) {
    const name = readNetworkDockerNetworkName(row.options, row.metadata)
    if (name) registered.add(name)
  }

  const missing = requiredNames.filter((name) => !registered.has(name))
  return missing.length > 0 ? missing.sort((a, b) => a.localeCompare(b)) : null
}
