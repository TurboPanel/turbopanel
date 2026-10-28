import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { AppEnv } from '../../app/app.ts'
import { nudgeTunnelRoutes, tunnelSyncDepsFrom } from '../../features/tunnels/nudge.ts'

/**
 * After a change that forwarding tables are built from (a site, its names, a
 * server, an address), send the tables now. The periodic sweep does the same,
 * so this never fails the request and does nothing when the organization has
 * no tunnels.
 */
export async function nudgeTunnelRoutesFromRequest(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string
): Promise<void> {
  await nudgeTunnelRoutes(
    db,
    tunnelSyncDepsFrom({
      commandQueue: c.get('commandQueue'),
      secretsConfig: c.get('secretsConfig'),
      dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
    }),
    organizationId
  )
}
