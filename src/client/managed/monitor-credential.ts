/**
 * Per-server ProxySQL monitor credentials (control-plane owned).
 *
 * ProxySQL's backend monitor credential is a single **global** setting per
 * ProxySQL instance, and one shared ProxySQL runs per server — so every
 * server monitors every backend it fronts with one identity. Host-local
 * random `monitor.cnf` seeds (the old Ansible-only model) cannot work for
 * cross-host clusters: the engine's monitor role is created on the primary
 * and replicated to standbys via WAL, so a single `tp_monitor` role can only
 * ever hold one host's password and every other server's monitor leg fails
 * auth.
 *
 * Model: the control plane mints one credential per server —
 * username `tp_monitor_<serverId prefix>`, sealed password stored on the
 * dedicated `monitor` table — and ships it two ways:
 *  - `managed.ingress.reconcile` carries the server's own credential so the
 *    daemon configures ProxySQL's monitor globals and rewrites `monitor.cnf`;
 *  - `managed.apply` (primary member) carries the credentials of **every
 *    fronting server** (members + bound consumers) as `monitorUsers`, so the
 *    engine creates one monitor role per server; standbys inherit the roles
 *    via WAL replay for free.
 *
 * **Why its own table and not `server.options`.** `options` is
 * operator-controlled configuration that the server routes return verbatim
 * (`GET /servers`, `GET /servers/:id`, the developer routes) and that the
 * approved cached read models copy into Redis. Anything stored there is
 * published to every client with read access to the server and cached outside
 * Postgres. A sealed secret has no business on that path, so it lives on the
 * `monitor` table, which nothing client-facing selects. Rows written by the
 * earlier `server.options.managedMonitor` model are **dropped, not adopted**
 * ({@link stripLegacyServerOptionsMonitor}): a password that was served to
 * clients is not one to keep using, and the next
 * reconcile + apply pair installs the freshly minted replacement.
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { monitor, server } from '../../lib/db/schema.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import {
  ENVELOPE_PREFIX_SECRET,
  generateSealedSecret,
} from '../authn/data-encryption.ts'

export type ServerMonitorCredential = {
  username: string
  /** Data-encryption sealed password (`ENVELOPE_PREFIX_SECRET`). */
  passwordSealed: string
}

/** Legacy `server.options` key this model replaced; never written again. */
export const LEGACY_SERVER_OPTIONS_MONITOR_KEY = 'managedMonitor'

/**
 * Deterministic per-server monitor username. Short id prefix keeps it inside
 * engine identifier limits while staying unique enough per fleet
 * (`tp_monitor_` + 12 hex chars of the server UUID).
 */
export function monitorUsernameForServer(serverId: string): string {
  return `tp_monitor_${serverId.replaceAll('-', '').slice(0, 12)}`
}

type MonitorRow = {
  username: string
  secretEnvelope: string
}

function parseStoredMonitor(
  row: MonitorRow | undefined,
  expectedUsername: string,
): ServerMonitorCredential | null {
  if (!row) return null
  if (
    row.username !== expectedUsername ||
    typeof row.secretEnvelope !== 'string' ||
    !row.secretEnvelope.startsWith(ENVELOPE_PREFIX_SECRET)
  ) {
    return null
  }
  return { username: row.username, passwordSealed: row.secretEnvelope }
}

const MONITOR_COLUMNS = {
  username: monitor.username,
  secretEnvelope: monitor.secretEnvelope,
} as const

async function loadServerMonitorRow(
  db: Db,
  serverId: string,
): Promise<MonitorRow | undefined> {
  const [row] = await db
    .select(MONITOR_COLUMNS)
    .from(monitor)
    .where(eq(monitor.serverId, serverId))
    .limit(1)
  return row
}

/**
 * Delete a pre-table `server.options.managedMonitor` blob.
 *
 * Idempotent and cheap — the existence test means the UPDATE touches nothing
 * once the key is gone. It runs on the mint path rather than a migration so a control
 * plane that never re-reconciles still stops publishing the old sealed password
 * the first time anything asks for that server's monitor credential.
 */
async function stripLegacyServerOptionsMonitor(
  db: Db,
  serverId: string,
): Promise<void> {
  await db
    .update(server)
    .set({
      options: sql`${server.options} - ${LEGACY_SERVER_OPTIONS_MONITOR_KEY}`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      // `jsonb_exists(...)` rather than the `?` operator: `?` is a placeholder
      // token in several drivers and does not survive every SQL-building path.
      sql`${server.id} = ${serverId} AND jsonb_exists(COALESCE(${server.options}, '{}'::jsonb), ${LEGACY_SERVER_OPTIONS_MONITOR_KEY})`,
    )
}

/**
 * Return the server's monitor credential, minting and persisting one on the
 * `monitor` table when absent (or when the stored shape is stale — e.g. a
 * legacy username).
 *
 * Concurrent mints resolve to one credential rather than racing: the insert
 * takes `uniq_monitor_server` or does nothing, and the loser re-reads the
 * winner's row. Only a genuinely stale row is overwritten.
 */
export async function ensureServerMonitorCredential(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  serverId: string,
): Promise<ServerMonitorCredential> {
  const expectedUsername = monitorUsernameForServer(serverId)
  const existing = parseStoredMonitor(
    await loadServerMonitorRow(db, serverId),
    expectedUsername,
  )
  if (existing) return existing

  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!serverRow) {
    throw new Error(`server not found for monitor credential: ${serverId}`)
  }

  const { sealed } = await generateSealedSecret(dataEncryptionSecrets)
  const now = new Date().toISOString()
  const inserted = await db
    .insert(monitor)
    .values({
      serverId,
      username: expectedUsername,
      secretEnvelope: sealed,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: monitor.serverId })
    .returning(MONITOR_COLUMNS)

  if (inserted.length === 0) {
    // A row exists: either a concurrent mint (keep it — it may already be on
    // its way to a daemon) or a stale shape this call must replace.
    const current = parseStoredMonitor(
      await loadServerMonitorRow(db, serverId),
      expectedUsername,
    )
    if (current) {
      await stripLegacyServerOptionsMonitor(db, serverId)
      return current
    }
    await db
      .update(monitor)
      .set({
        username: expectedUsername,
        secretEnvelope: sealed,
        updatedAt: now,
      })
      .where(eq(monitor.serverId, serverId))
  }

  await stripLegacyServerOptionsMonitor(db, serverId)
  return { username: expectedUsername, passwordSealed: sealed }
}
