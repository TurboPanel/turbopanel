/**
 * Hand-curated canonical schema. Column order (especially the trailing
 * `metadata`/`options` pair) is intentional and maintained by hand — do **not**
 * re-introspect (`dev/scripts/introspect.sh`) over this file; that reorders
 * columns and clobbers the manual layout. Generate versioned SQL via
 * `pnpm generate --name <summary>`.
 */

import { sql } from 'drizzle-orm'
import {
  pgTable,
  index,
  uniqueIndex,
  foreignKey,
  uuid,
  timestamp,
  varchar,
  text,
  unique,
  check,
  jsonb,
  integer,
  boolean,
} from 'drizzle-orm/pg-core'
import { cidr, inet } from './net-types.ts'

export const invitation = pgTable(
  'invitation',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    email: varchar({ length: 255 }).notNull(),
    status: varchar({ length: 255 }).notNull(),
    /** Intended access grants materialized on accept — see `InvitationGrantSpec`. */
    grants: jsonb(),
  },
  (table) => [
    index('idx_invitation_email').using('btree', table.email.asc().nullsLast().op('text_ops')),
    index('idx_invitation_user_id').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_invitation_team_id').using(
      'btree',
      table.teamId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'invitation_user_id_user_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [team.id],
      name: 'invitation_team_id_team_id_fk',
    }).onDelete('cascade'),
  ]
)
export const organization = pgTable(
  'organization',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    displayName: varchar('display_name', { length: 255 }),
    slug: varchar({ length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    unique('organization_slug_unique').on(table.slug),
    check(
      'organization_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * Organization TLS certificate library (upload / Let's Encrypt / self-signed).
 * Private keys are sealed `tpsecret` envelopes — never returned on client GET.
 * Hosting pins via `hosting.tls_id`; unset uses Caddy `tls internal` (self-signed).
 */
export const tls = pgTable(
  'tls',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    /** `upload` | `lets_encrypt` | `self_signed` */
    source: text().notNull(),
    /** Leaf + intermediate chain PEM; null while LE `pending`. */
    certificatePem: text('certificate_pem'),
    /** Sealed `tpsecret` private key PEM; null while LE `pending` before keygen. */
    privateKeyPem: text('private_key_pem'),
    /** `ready` | `pending` | `expired` | `failed` | `revoked` */
    status: text().default('ready').notNull(),
    notAfter: timestamp('not_after', { precision: 3, withTimezone: true, mode: 'string' }),
    fingerprintSha256: text('fingerprint_sha256'),
    metadata: jsonb().notNull(),
    options: jsonb(),
  },
  (table) => [
    index('idx_tls_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_tls_not_after').using(
      'btree',
      table.notAfter.asc().nullsLast().op('timestamptz_ops')
    ),
    uniqueIndex('uniq_tls_organization_fingerprint_sha256')
      .on(table.organizationId, table.fingerprintSha256)
      .where(sql`${table.fingerprintSha256} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tls_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'tls_source_check',
      sql`source IN ('upload', 'lets_encrypt', 'self_signed')`
    ),
    check(
      'tls_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
export const passkey = pgTable(
  'passkey',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    aaguid: text(),
    name: varchar({ length: 255 }),
    publicKey: text('public_key').notNull(),
    credentialId: varchar('credential_id', { length: 255 }).notNull(),
    counter: integer().default(0).notNull(),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    isBackedUp: boolean('is_backed_up').notNull(),
    transports: text(),
  },
  (table) => [
    index('idx_passkey_credential_id').using(
      'btree',
      table.credentialId.asc().nullsLast().op('text_ops')
    ),
    index('idx_passkey_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'passkey_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
export const member = pgTable(
  'member',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    index('idx_member_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_member_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'member_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'member_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('member_org_user_unique').on(table.organizationId, table.userId),
  ]
)
/**
 * Physical site grouping servers that share a private L2/L3 network; optional —
 * servers may have no datacenter. `options` mirrors `organization.options` for
 * `defaultServerTimezone` / `enforceServerTimezone` (consumed by the next phase's
 * resolver). Must stay declared before `server` (same rule as `license`).
 */
export const datacenter = pgTable(
  'datacenter',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_datacenter_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'datacenter_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'datacenter_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
export const server = pgTable(
  'server',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id'),
    datacenterId: uuid('datacenter_id'),
    displayName: varchar('display_name', { length: 255 }),
    hostname: varchar('hostname', { length: 255 }),
    machineId: varchar('machine_id', { length: 255 }),
    connected: boolean().default(false).notNull(),
    /** `online` | `offline` | `unknown` — projected fleet liveness. */
    daemonStatus: text('daemon_status').default('unknown').notNull(),
    lastSeenAt: timestamp('last_seen_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    connectedAt: timestamp('connected_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    disconnectedAt: timestamp('disconnected_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    statusChangedAt: timestamp('status_changed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Sparse `{ key, projection? }` — status lives in dedicated columns. */
    daemon: jsonb(),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_server_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_server_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_server_machine_id').using(
      'btree',
      table.machineId.asc().nullsLast().op('text_ops')
    ),
    index('idx_server_hostname').using(
      'btree',
      table.hostname.asc().nullsLast().op('text_ops')
    ),
    index('idx_server_daemon_status').using(
      'btree',
      table.daemonStatus.asc().nullsLast().op('text_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'server_organization_id_organization_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'server_datacenter_id_datacenter_id_fk',
    }).onDelete('set null'),
    check(
      'server_daemon_status_check',
      sql`${table.daemonStatus} IN ('online', 'offline', 'unknown')`
    ),
  ]
)
/**
 * Organization-scoped registration keys. Consumption latches on `server_id`
 * (one license per server). Defined after `server` so the FK can reference it.
 */
export const license = pgTable(
  'license',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** Set on first successful enroll — one-shot seat latch. */
    serverId: uuid('server_id'),
    displayName: varchar('display_name', { length: 255 }),
    /** Argon2id PHC hashed token — same format as account.password */
    token: text().notNull(),
    /** Soft-delete */
    revokedAt: timestamp('revoked_at', { precision: 3, withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_license_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    // One license per server once consumed (revoked rows keep server_id for audit).
    uniqueIndex('uniq_license_server_id')
      .on(table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'license_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'license_server_id_server_id_fk',
    }).onDelete('set null'),
  ]
)
export const command = pgTable(
  'command',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    name: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().default(0).notNull(),
    payload: jsonb().notNull(),
    result: jsonb(),
    metadata: jsonb().notNull(),
  },
  (table) => [
    index('idx_command_server_id_created_at').using(
      'btree',
      table.serverId.asc(),
      table.createdAt.desc()
    ),
    index('idx_command_status').using('btree', table.status.asc()),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'command_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Org-owned network registry. Today holds datacenter and server networks;
 * `kind = 'docker'` is the seam for per-compose Docker networks — hence nullable
 * `cidr` and org ownership rather than server ownership.
 */
export const network = pgTable(
  'network',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    serverId: uuid('server_id'),
    kind: text().notNull(),
    cidr: cidr(),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_network_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_network_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_network_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'network_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'network_datacenter_id_datacenter_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'network_server_id_server_id_fk',
    }).onDelete('restrict'),
    check(
      'network_kind_check',
      sql`kind IN ('datacenter', 'server', 'docker')`
    ),
    check(
      'network_single_scope_check',
      sql`(
        (${table.kind} = 'datacenter' AND ${table.datacenterId} IS NOT NULL AND ${table.serverId} IS NULL) OR
        (${table.kind} = 'server' AND ${table.serverId} IS NOT NULL AND ${table.datacenterId} IS NULL) OR
        (${table.kind} = 'docker' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL)
      )`
    ),
    check(
      'network_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/** Org-scoped WireGuard mesh — owns its overlay CIDR directly (no `network` row). */
export const vpn = pgTable(
  'vpn',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** Overlay tunnel subnet for this mesh. */
    cidr: cidr().notNull(),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_vpn_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'vpn_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_vpn_organization_id_cidr').on(
      table.organizationId,
      table.cidr
    ),
    check(
      'vpn_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * Single source of truth for every managed address. There is deliberately **no**
 * `server.datacenter_private_ip` column — a server's private address is
 * `ip WHERE server_id = … AND scope = 'datacenter'`. Public VPS addresses carry
 * no `network_id`. Overlay tunnel addresses are `scope = 'vpn'` with `vpn_id`.
 * Address family (`version`) is derived from `address` in the API — not stored.
 */
export const ip = pgTable(
  'ip',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    networkId: uuid('network_id'),
    serverId: uuid('server_id'),
    vpnId: uuid('vpn_id'),
    address: inet('address').notNull(),
    allocation: text().notNull(),
    scope: text().notNull(),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_ip_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_network_id').using('btree', table.networkId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_vpn_id').using('btree', table.vpnId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'ip_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'ip_datacenter_id_datacenter_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.networkId],
      foreignColumns: [network.id],
      name: 'ip_network_id_network_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'ip_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.vpnId],
      foreignColumns: [vpn.id],
      name: 'ip_vpn_id_vpn_id_fk',
    }).onDelete('cascade'),
    check('ip_allocation_check', sql`allocation IN ('dedicated', 'shared')`),
    check('ip_scope_check', sql`scope IN ('public', 'datacenter', 'loopback', 'vpn')`),
    check(
      'ip_vpn_scope_check',
      sql`(${table.scope} = 'vpn' AND ${table.vpnId} IS NOT NULL) OR (${table.scope} <> 'vpn' AND ${table.vpnId} IS NULL)`
    ),
    check(
      'ip_datacenter_free_pool_check',
      sql`(${table.datacenterId} IS NULL) OR (${table.serverId} IS NULL AND ${table.vpnId} IS NULL AND ${table.networkId} IS NULL)`
    ),
    uniqueIndex('uniq_ip_org_address')
      .on(table.organizationId, table.address)
      .where(sql`${table.vpnId} IS NULL`),
    uniqueIndex('uniq_ip_vpn_address')
      .on(table.vpnId, table.address)
      .where(sql`${table.vpnId} IS NOT NULL`),
    check(
      'ip_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * One server's membership in a VPN mesh.
 *
 * **WireGuard private keys are never stored in Postgres** — the daemon generates
 * and holds the keypair on the host and reports only the public key back
 * (`public_key` stays null until the first successful Apply). Overlay addresses
 * live as `ip(scope='vpn')` rows referenced by `tunnel_ip_id`.
 */
export const peer = pgTable(
  'peer',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    vpnId: uuid('vpn_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** Public `ip` row used as the WireGuard endpoint. */
    endpointIpId: uuid('endpoint_ip_id'),
    /** Overlay `ip` row (`scope = 'vpn'`) for this peer's tunnel address. */
    tunnelIpId: uuid('tunnel_ip_id'),
    /**
     * Mesh role — `gateway` advertises its datacenter CIDR to remote peers;
     * `member` is host-route only.
     */
    role: text().notNull().default('member'),
    /**
     * Daemon-reported WireGuard public key. Null until the first successful
     * `server.wireguard.apply` reconciles the host keypair.
     */
    publicKey: text('public_key'),
    listenPort: integer('listen_port'),
    endpoint: varchar({ length: 255 }),
    /** Sealed `tpsecret` envelope — write-only, same handling as `principal.password`. */
    presharedKey: text('preshared_key'),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_peer_vpn_id').using('btree', table.vpnId.asc().nullsLast().op('uuid_ops')),
    index('idx_peer_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_peer_endpoint_ip_id').using(
      'btree',
      table.endpointIpId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_peer_tunnel_ip_id').using(
      'btree',
      table.tunnelIpId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.vpnId],
      foreignColumns: [vpn.id],
      name: 'peer_vpn_id_vpn_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'peer_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.endpointIpId],
      foreignColumns: [ip.id],
      name: 'peer_endpoint_ip_id_ip_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.tunnelIpId],
      foreignColumns: [ip.id],
      name: 'peer_tunnel_ip_id_ip_id_fk',
    }).onDelete('restrict'),
    unique('peer_vpn_server_unique').on(table.vpnId, table.serverId),
    unique('peer_vpn_public_key_unique').on(table.vpnId, table.publicKey),
    uniqueIndex('uniq_peer_vpn_tunnel_ip')
      .on(table.vpnId, table.tunnelIpId)
      .where(sql`${table.tunnelIpId} IS NOT NULL`),
    check('peer_role_check', sql`role IN ('gateway', 'member')`),
  ]
)
export const workspace = pgTable(
  'workspace',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_workspace_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'workspace_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'workspace_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
export const project = pgTable(
  'project',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_project_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'project_workspace_id_workspace_id_fk',
    }).onDelete('restrict'),
    check(
      'project_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)

export const environment = pgTable(
  'environment',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    projectId: uuid('project_id').notNull(),
    /** Whole-server placement pin — single source of truth (not compose / metadata). */
    serverId: uuid('server_id'),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_environment_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_environment_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'environment_project_id_project_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'environment_server_id_server_id_fk',
    }).onDelete('restrict'),
    check(
      'environment_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)

export const managed = pgTable(
  'managed',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    /** Environment-scoped managed engine service (1:1 with environment). */
    environmentId: uuid('environment_id').notNull(),
    /**
     * Placement pin for the managed service host. Mirrors
     * `environment.server_id` at provision time so managed engines can move
     * independently of the environment's deploy placement later.
     */
    serverId: uuid('server_id'),
    displayName: varchar('display_name', { length: 255 }),
    /** Catalog engine code (e.g. `postgres`, `redis`). */
    engine: text(),
    /** `provisioning` | `applying` | `ready` | `stopped` | `failed` */
    status: text(),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_managed_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_managed_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_managed_engine').using(
      'btree',
      table.engine.asc().nullsLast().op('text_ops')
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'managed_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'managed_server_id_server_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('managed_environment_id_unique').on(table.environmentId),
    check(
      'managed_display_name_format_check',
      sql`(${table.displayName} IS NULL) OR (((char_length((${table.displayName})::text) >= 1) AND (char_length((${table.displayName})::text) <= 255)) AND ((${table.displayName})::text ~ '^[A-Za-z0-9 ._-]+$'::text))`,
    ),
    check(
      'managed_status_check',
      sql`status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed')`,
    ),
  ]
)
export const variable = pgTable(
  'variable',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id'),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    hostingId: uuid('hosting_id'),
    serverId: uuid('server_id'),
    key: varchar({ length: 255 }).notNull(),
    value: text().default('').notNull(),
    isSecret: boolean('is_secret').default(false).notNull(),
    isLiteral: boolean('is_literal').default(false).notNull(),
    forBuild: boolean('for_build').default(false).notNull(),
    forRuntime: boolean('for_runtime').default(true).notNull(),
    description: varchar('description', { length: 255 }),
  },
  (table) => [
    index('idx_variable_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_hosting_id').using(
      'btree',
      table.hostingId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_variable_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'variable_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'variable_workspace_id_workspace_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'variable_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'variable_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'variable_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.hostingId],
      foreignColumns: [hosting.id],
      name: 'variable_hosting_id_hosting_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'variable_server_id_server_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_var_org')
      .on(table.key, table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    uniqueIndex('uniq_var_workspace')
      .on(table.key, table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    uniqueIndex('uniq_var_project')
      .on(table.key, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    uniqueIndex('uniq_var_environment')
      .on(table.key, table.environmentId)
      .where(sql`${table.environmentId} IS NOT NULL`),
    uniqueIndex('uniq_var_service')
      .on(table.key, table.serviceId)
      .where(sql`${table.serviceId} IS NOT NULL`),
    uniqueIndex('uniq_var_hosting')
      .on(table.key, table.hostingId)
      .where(sql`${table.hostingId} IS NOT NULL`),
    uniqueIndex('uniq_var_server')
      .on(table.key, table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    check(
      'variable_exactly_one_parent_check',
      sql`((organization_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (hosting_id IS NOT NULL)::int +
        (server_id IS NOT NULL)::int) = 1`
    ),
    check(
      'variable_key_format_check',
      sql`(char_length(key) >= 1) AND (char_length(key) <= 255) AND (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`
    ),
  ]
)
export const service = pgTable(
  'service',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    environmentId: uuid('environment_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
    /**
     * Compose service key — preferred over displayName for reconcile/deploy matching.
     * Unique per environment when non-null (`uniq_service_environment_compose_name`);
     * displayName itself is not unique and must not be assumed so.
     */
    composeServiceName: varchar('compose_service_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_service_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    /** Partial unique: multiple NULL compose names allowed; non-null must be unique per environment. */
    uniqueIndex('uniq_service_environment_compose_name')
      .on(table.environmentId, table.composeServiceName)
      .where(sql`${table.composeServiceName} IS NOT NULL`),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'service_environment_id_environment_id_fk',
    }).onDelete('restrict'),
    check(
      'service_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
export const hosting = pgTable(
  'hosting',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    serviceId: uuid('service_id').notNull(),
    /** Optional pin into the org TLS library; null = Caddy tls internal (self-signed). */
    tlsId: uuid('tls_id'),
    /** Optional pin to a managed `ip` row for ingress addressing. */
    ipId: uuid('ip_id'),
    displayName: varchar('display_name', { length: 255 }),
    description: varchar('description', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_hosting_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_hosting_tls_id').using('btree', table.tlsId.asc().nullsLast().op('uuid_ops')),
    index('idx_hosting_ip_id').using('btree', table.ipId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'hosting_service_id_service_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tlsId],
      foreignColumns: [tls.id],
      name: 'hosting_tls_id_tls_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.ipId],
      foreignColumns: [ip.id],
      name: 'hosting_ip_id_ip_id_fk',
    }).onDelete('set null'),
    check(
      'hosting_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
export const container = pgTable(
  'container',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** Docker container id reported by the daemon after deploy. */
    containerId: text('container_id').notNull(),
    containerName: text('container_name').notNull(),
    status: text('status').notNull(),
    composeServiceName: text('compose_service_name').notNull(),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_container_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_container_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_container_status').using(
      'btree',
      table.status.asc().nullsLast().op('text_ops')
    ),
    uniqueIndex('uniq_container_server_container_id').on(table.serverId, table.containerId),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'container_service_id_service_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'container_server_id_server_id_fk',
    }).onDelete('restrict'),
  ]
)
/**
 * A principal is an account identity that can be attached to services — a host
 * (PAM) user or a database engine user. Org is derived through `assignment` →
 * `service`; there is deliberately no `organization_id` column here.
 */
export const principal = pgTable(
  'principal',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    /** `system` (host/PAM account) | `database` (engine account) */
    kind: text().notNull(),
    /** `pam` | `postgres` | `mysql` | `redis` | `clickhouse` */
    provider: text().notNull(),
    /**
     * Account name. Allowlist mirrors POSIX/database account naming: starts
     * with a letter or underscore, then letters/digits/underscore/hyphen
     * (`^[A-Za-z_][A-Za-z0-9_-]*$`), 1–255 chars.
     */
    username: varchar({ length: 255 }).notNull(),
    /**
     * Write-only credential. Stored as a `tpsecret.v1…` envelope (instance
     * at-rest seal). Never returned on GET; delivery re-seals to `tpdaemon`
     * for the target daemon.
     */
    password: text(),
    /** Optional project scope for hosting principals. */
    projectId: uuid('project_id'),
    /** Optional managed-engine scope (cascade-deletes with the managed row). */
    managedId: uuid('managed_id'),
    /** Holds `uid` / `gid` / `home`. */
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_principal_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_principal_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'principal_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'principal_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    check('principal_kind_check', sql`kind IN ('system', 'database')`),
    check(
      'principal_provider_check',
      sql`provider IN ('pam', 'postgres', 'mysql', 'redis', 'clickhouse')`
    ),
    check(
      'principal_username_format_check',
      sql`(char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    // No global unique on `username`: the same account name (e.g. `postgres`,
    // `www-data`) legitimately recurs across different systems/services.
  ]
)
/**
 * Join edge: principal ↔ service (many-to-many). Deleting a principal removes
 * its edges (cascade); a service still referenced by principals cannot be
 * deleted (restrict), mirroring `container`'s restrict on `service`.
 */
export const assignment = pgTable(
  'assignment',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    serviceId: uuid('service_id').notNull(),
  },
  (table) => [
    index('idx_assignment_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_assignment_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'assignment_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'assignment_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('assignment_principal_service_unique').on(table.principalId, table.serviceId),
  ]
)
export const storage = pgTable(
  'storage',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    serverId: uuid('server_id'),
    kind: text().notNull(),
    name: varchar({ length: 255 }).notNull(),
    sourcePath: text('source_path'),
    destinationPath: text('destination_path'),
    principalId: uuid('principal_id'),
    /** Sealed file content (`tpsecret` or `tpdaemon`) for `kind=file` entries. */
    contentEnvelope: text('content_envelope'),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_storage_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_storage_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_storage_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_storage_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_storage_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'storage_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'storage_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'storage_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'storage_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'storage_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'storage_principal_id_principal_id_fk',
    }).onDelete('set null'),
    check(
      'storage_kind_check',
      sql`kind IN ('docker_volume', 'bind_mount', 'file', 'directory')`,
    ),
    check(
      'storage_exactly_one_parent_check',
      sql`((project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) = 1`,
    ),
  ],
)
export const grant = pgTable(
  'grant',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    permission: text().notNull(),
    allow: boolean().notNull().default(true),
  },
  (table) => [
    unique('grant_unique').on(
      table.entityType,
      table.entityId,
      table.actorType,
      table.actorId,
      table.permission
    ),
    index('idx_grant_entity').on(table.entityType, table.entityId),
    index('idx_grant_actor').on(table.actorType, table.actorId),
  ]
)
export const session = pgTable(
  'session',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    token: varchar({ length: 255 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('idx_session_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'session_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('session_token_unique').on(table.token),
  ]
)
export const setting = pgTable(
  'setting',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    key: text().notNull(),
    value: jsonb().notNull(),
  },
  (table) => [unique('setting_key_unique').on(table.key)]
)
export const account = pgTable(
  'account',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    providerId: text('provider_id').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    scope: text(),
    password: text(),
  },
  (table) => [
    index('idx_account_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'account_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
export const teammate = pgTable(
  'teammate',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    index('idx_teammate_team_id').using('btree', table.teamId.asc().nullsLast().op('uuid_ops')),
    index('idx_teammate_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [team.id],
      name: 'teammate_team_id_team_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'teammate_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('teammate_team_user_unique').on(table.teamId, table.userId),
  ]
)
export const team = pgTable(
  'team',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_team_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'team_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'team_display_name_format_check',
      sql`(display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255))`
    ),
  ]
)
export const user = pgTable(
  'user',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    displayName: varchar('display_name', { length: 255 }),
    username: varchar({ length: 255 }),
    displayUsername: varchar('display_username', { length: 255 }),
    email: varchar({ length: 255 }).notNull(),
    isEmailVerified: boolean('is_email_verified').default(false).notNull(),
    is2FaEnabled: boolean('is_2fa_enabled').default(false).notNull(),
    isDisabled: boolean('is_disabled').default(false).notNull(),
    role: text().default('user').notNull(),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    unique('user_email_unique').on(table.email),
    unique('user_username_unique').on(table.username),
    check(
      'user_display_name_format_check',
      sql`(display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255))`
    ),
    check(
      'user_username_format_check',
      sql`(username IS NULL) OR ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255))`
    ),
    check(
      'user_display_username_format_check',
      sql`(display_username IS NULL) OR ((char_length((display_username)::text) >= 1) AND (char_length((display_username)::text) <= 255))`
    ),
  ]
)
export const twoFactor = pgTable(
  '2fa',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    userId: uuid('user_id').notNull(),
    secret: varchar({ length: 255 }).notNull(),
    isVerified: boolean('is_verified').default(true),
    backupCodes: text('backup_codes').notNull(),
  },
  (table) => [
    index('idx_2fa_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: '2fa_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
export const verification = pgTable(
  'verification',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    createdAt: timestamp('created_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    identifier: varchar({ length: 255 }).notNull(),
    value: text().notNull(),
  },
  (table) => [
    unique('verification_identifier_unique').on(table.identifier),
  ]
)
