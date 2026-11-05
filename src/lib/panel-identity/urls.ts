import type { Db } from '../../db/connection.ts'
import { listInstanceHostnames } from '../../features/install/instance-hostnames.ts'
import { installUrlsFor } from '../../features/install/public-origins.ts'

/**
 * The addresses a server may dial, for the identity document and the signed
 * hello on a self-hosted control plane: the public origin of every hostname
 * servers dial, the primary first (URL 0 is the install URL). The same list
 * the install command carries, so a pinned server that follows the document
 * never learns an address the administrator marked as not for servers.
 */
export async function serverDialOrigins(db: Db): Promise<string[]> {
  return installUrlsFor(await listInstanceHostnames(db))
}
