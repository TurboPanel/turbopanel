import { eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { server } from "../../lib/db/schema.ts";
import type {
  ServerMetadata,
  ServerOptions,
} from "../../lib/db/server-metadata.ts";

/**
 * Precedence when resolving cell fields: `server.options` overrides
 * `server.metadata` when both define a value. Enrollment may persist copies in
 * either column; later backend updates are expected in `options`.
 */
function resolveCellLocationHintFromRow(
  metadata: ServerMetadata | null | undefined,
  options: ServerOptions | null | undefined,
): string | undefined {
  return options?.cellLocationHint ?? metadata?.cellLocationHint;
}

async function loadServerCellColumns(
  db: Db,
  serverId: string,
): Promise<{
  metadata: ServerMetadata | null | undefined;
  options: ServerOptions | null | undefined;
}> {
  const rows = await db
    .select({ metadata: server.metadata, options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);

  const row = rows[0];
  return {
    metadata: row?.metadata as ServerMetadata | null | undefined,
    options: row?.options as ServerOptions | null | undefined,
  };
}

/**
 * Reads `cellLocationHint` from `server.options` then `server.metadata`.
 *
 * `locationHint` is an enrollment-time decision. Cloudflare only respects it on
 * the first `getByName()` call for a given object name.
 */
export async function resolveCellLocationHint(
  db: Db,
  serverId: string,
): Promise<string | undefined> {
  const { metadata, options } = await loadServerCellColumns(db, serverId);
  return resolveCellLocationHintFromRow(metadata, options);
}
