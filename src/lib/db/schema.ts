/**
 * Hand-curated canonical schema. Column order is intentional and maintained by
 * hand — do **not** re-introspect (`dev/scripts/introspect.sh`) over this file;
 * that reorders columns and clobbers the manual layout. Generate versioned SQL
 * via `pnpm generate --name <summary>`.
 *
 * Tables with a `metadata`/`options` pair use:
 *   id → created_at → updated_at → metadata → options → …remaining columns
 * If a table has one of those JSONB columns, it must have both — and both are
 * always nullable (`jsonb()`, never `.notNull()`).
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
    metadata: jsonb(),
    options: jsonb(),
    name: varchar({ length: 255 }),
    slug: varchar({ length: 255 }),
  },
  (table) => [
    unique('organization_slug_unique').on(table.slug),
    check(
      'organization_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
    /** `upload` | `lets_encrypt` | `self_signed` | `organization_ca` */
    source: text().notNull(),
    /** Leaf + intermediate chain PEM; null while LE `pending`. */
    certificatePem: text('certificate_pem'),
    /** Sealed `tpsecret` private key PEM; null while LE `pending` before keygen. */
    privateKeyPem: text('private_key_pem'),
    /** `ready` | `pending` | `expired` | `failed` | `revoked` */
    status: text().default('ready').notNull(),
    notAfter: timestamp('not_after', { precision: 3, withTimezone: true, mode: 'string' }),
    fingerprintSha256: text('fingerprint_sha256'),
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
    uniqueIndex('uniq_tls_organization_active_ca')
      .on(table.organizationId)
      .where(sql`${table.source} = 'organization_ca' AND ${table.status} != 'revoked'`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tls_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'tls_source_check',
      sql`source IN ('upload', 'lets_encrypt', 'self_signed', 'organization_ca')`
    ),
    check(
      'tls_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
/**
 * Organization membership (user ↔ organization). Physical table is
 * `membership` (not Better Auth’s default `member`) — map the auth org model
 * onto this table when wiring Better Auth.
 */
export const membership = pgTable(
  'membership',
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
    index('idx_membership_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_membership_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'membership_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'membership_user_id_user_id_fk',
    }).onDelete('cascade'),
    unique('membership_org_user_unique').on(table.organizationId, table.userId),
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
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
      'datacenter_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id'),
    datacenterId: uuid('datacenter_id'),
    name: varchar({ length: 255 }),
    hostname: varchar('hostname', { length: 255 }),
    /**
     * Derived HMAC of the host machine-id (not the raw value, not a sealed
     * secret). Deterministic so it can be equality-matched and echoed into
     * signed enroll/auth payloads.
     */
    machineKey: text('machine_key'),
    /**
     * Fleet liveness flag. Tri-state `online|offline|unknown` is derived from
     * `connected` + `status_changed_at` (never stored).
     */
    connected: boolean().default(false).notNull(),
    /**
     * Last status transition (`connected` flip). Feeds derived `connectedAt`
     * (when connected) / `offlineAt` (when not). `online|offline|unknown` is
     * derived, never stored.
     */
    statusChangedAt: timestamp('status_changed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Sparse `{ key, projection? }` — status lives in dedicated columns. */
    daemon: jsonb(),
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
    index('idx_server_machine_key').using(
      'btree',
      table.machineKey.asc().nullsLast().op('text_ops')
    ),
    index('idx_server_hostname').using(
      'btree',
      table.hostname.asc().nullsLast().op('text_ops')
    ),
    index('idx_server_connected')
      .on(table.id)
      .where(sql`${table.connected}`),
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
    name: varchar({ length: 255 }),
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
    metadata: jsonb(),
    options: jsonb(),
    serverId: uuid('server_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    name: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().default(0).notNull(),
    payload: jsonb().notNull(),
    result: jsonb(),
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
 * Org-owned network registry: datacenter site CIDRs (`kind = 'datacenter'`),
 * external Docker registrations (`kind = 'docker'`, optional `server_id`),
 * and TurboFabric logical spanning networks (`kind = 'compose'`).
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    serverId: uuid('server_id'),
    /**
     * Optional pin for `kind = 'compose'` logical spanning networks
     * (null = org-shared). No FK here — `environment` is declared later;
     * compiler writes this id from a live environment row.
     */
    environmentId: uuid('environment_id'),
    kind: text().notNull(),
    cidr: cidr(),
    name: varchar({ length: 255 }),
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
    index('idx_network_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops'),
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
      sql`kind IN ('datacenter', 'docker', 'compose')`
    ),
    check(
      'network_single_scope_check',
      sql`(
        (${table.kind} = 'datacenter' AND ${table.datacenterId} IS NOT NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL) OR
        (${table.kind} = 'docker' AND ${table.datacenterId} IS NULL AND ${table.environmentId} IS NULL) OR
        (${table.kind} = 'compose' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL)
      )`
    ),
    check(
      'network_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Overlay tunnel subnet for this mesh. */
    cidr: cidr().notNull(),
    name: varchar({ length: 255 }),
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
      'vpn_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * Org TurboFabric mesh (host interface `tp0`). At most one row per
 * organization; **absence means TurboFabric is off**. Container-pool CIDR and
 * listen port live in `options`. Private keys never stored.
 */
export const fabric = pgTable(
  'fabric',
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Host fabric subnet for `tp0` addresses (e.g. `10.250.0.0/16`). */
    cidr: cidr().notNull(),
    name: varchar({ length: 255 }),
  },
  (table) => [
    uniqueIndex('uniq_fabric_organization_id').on(table.organizationId),
    index('idx_fabric_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'fabric_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'fabric_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ],
)
/**
 * Single source of truth for every managed address. Two non-overlapping private
 * facts: **site CIDR** lives on `network(kind='datacenter', datacenter_id=…)`;
 * **a server's private address** is `ip WHERE server_id = … AND scope = 'datacenter'`.
 * Public VPS addresses carry no `network_id`. Overlay tunnel addresses are
 * `scope = 'vpn'` with `vpn_id`. TurboFabric `tp0` addresses are
 * `scope = 'fabric'` with `fabric_id`. Address family (`version`) is derived from
 * `address` in the API — not stored.
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    networkId: uuid('network_id'),
    serverId: uuid('server_id'),
    vpnId: uuid('vpn_id'),
    fabricId: uuid('fabric_id'),
    address: inet('address').notNull(),
    allocation: text().notNull(),
    scope: text().notNull(),
    name: varchar({ length: 255 }),
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
    index('idx_ip_fabric_id').using('btree', table.fabricId.asc().nullsLast().op('uuid_ops')),
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
    foreignKey({
      columns: [table.fabricId],
      foreignColumns: [fabric.id],
      name: 'ip_fabric_id_fabric_id_fk',
    }).onDelete('cascade'),
    check('ip_allocation_check', sql`allocation IN ('dedicated', 'shared')`),
    check('ip_scope_check', sql`scope IN ('public', 'datacenter', 'vpn', 'fabric')`),
    check(
      'ip_vpn_scope_check',
      sql`(${table.scope} = 'vpn' AND ${table.vpnId} IS NOT NULL) OR (${table.scope} <> 'vpn' AND ${table.vpnId} IS NULL)`
    ),
    check(
      'ip_fabric_scope_check',
      sql`(${table.scope} = 'fabric' AND ${table.fabricId} IS NOT NULL) OR (${table.scope} <> 'fabric' AND ${table.fabricId} IS NULL)`
    ),
    check(
      'ip_datacenter_scope_check',
      sql`(${table.scope} <> 'datacenter') OR (${table.serverId} IS NOT NULL OR ${table.datacenterId} IS NOT NULL)`
    ),
    check(
      'ip_datacenter_free_pool_check',
      sql`(${table.datacenterId} IS NULL) OR (${table.serverId} IS NULL AND ${table.vpnId} IS NULL AND ${table.networkId} IS NULL AND ${table.fabricId} IS NULL)`
    ),
    uniqueIndex('uniq_ip_org_address')
      .on(table.organizationId, table.address)
      .where(sql`${table.vpnId} IS NULL AND ${table.fabricId} IS NULL`),
    uniqueIndex('uniq_ip_vpn_address')
      .on(table.vpnId, table.address)
      .where(sql`${table.vpnId} IS NOT NULL`),
    uniqueIndex('uniq_ip_fabric_address')
      .on(table.fabricId, table.address)
      .where(sql`${table.fabricId} IS NOT NULL`),
    check(
      'ip_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
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
/**
 * One server in an org TurboFabric mesh (parallel to VPN `peer` / managed
 * `node`). Private key never stored; `public_key` stays null until the first
 * successful `server.fabric.reconcile`. `prefix` is that server's container
 * aggregate, forwarded over `tp0`.
 */
export const relay = pgTable(
  'relay',
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
    metadata: jsonb(),
    options: jsonb(),
    fabricId: uuid('fabric_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `ip(scope='fabric')` row for this server's `tp0` /32. */
    fabricIpId: uuid('fabric_ip_id'),
    publicKey: text('public_key'),
    /** Container aggregate CIDR forwarded via this relay (e.g. `10.192.0.0/16`). */
    prefix: cidr().notNull(),
  },
  (table) => [
    index('idx_relay_fabric_id').using(
      'btree',
      table.fabricId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_relay_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_relay_fabric_ip_id').using(
      'btree',
      table.fabricIpId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.fabricId],
      foreignColumns: [fabric.id],
      name: 'relay_fabric_id_fabric_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'relay_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.fabricIpId],
      foreignColumns: [ip.id],
      name: 'relay_fabric_ip_id_ip_id_fk',
    }).onDelete('restrict'),
    unique('relay_fabric_server_unique').on(table.fabricId, table.serverId),
  ],
)
/**
 * A logical `kind='compose'` network present on this server, with a local
 * bridge subnet carved from that relay's prefix.
 */
export const span = pgTable(
  'span',
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
    metadata: jsonb(),
    options: jsonb(),
    networkId: uuid('network_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** Server-local bridge subnet. */
    cidr: cidr().notNull(),
  },
  (table) => [
    index('idx_span_network_id').using(
      'btree',
      table.networkId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_span_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.networkId],
      foreignColumns: [network.id],
      name: 'span_network_id_network_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'span_server_id_server_id_fk',
    }).onDelete('restrict'),
    unique('span_network_server_unique').on(table.networkId, table.serverId),
  ],
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
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
    kind: varchar({ length: 32 }).notNull().default('user'),
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
      'workspace_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    check('workspace_kind_check', sql`kind IN ('user', 'turbopanel')`),
    uniqueIndex('uniq_workspace_organization_turbopanel')
      .on(table.organizationId)
      .where(sql`kind = 'turbopanel'`),
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
    metadata: jsonb(),
    options: jsonb(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
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
      'project_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    /**
     * One project per system component per workspace (system hierarchy).
     * Partial — user projects omit `metadata.component`.
     */
    uniqueIndex('uniq_project_workspace_system_component')
      .on(table.workspaceId, sql`(metadata->>'component')`)
      .where(sql`(metadata->>'component') IS NOT NULL`),
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
    metadata: jsonb(),
    options: jsonb(),
    projectId: uuid('project_id').notNull(),
    /** Whole-server placement pin — single source of truth (not compose / metadata). */
    serverId: uuid('server_id'),
    /**
     * Monotonic desired generation, bumped once per deploy and fanned into
     * `deployment.desired_generation`.
     */
    generation: integer().default(0).notNull(),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
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
      'environment_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
  
    /** Environment-scoped managed engine service (1:1 with environment). */
    environmentId: uuid('environment_id').notNull(),
    /**
     * Placement pin for the managed service host. Mirrors
     * `environment.server_id` at provision time so managed engines can move
     * independently of the environment's deploy placement later.
     */
    serverId: uuid('server_id'),
    name: varchar({ length: 255 }),
    /** Catalog engine code (e.g. `postgres`, `redis`). */
    engine: text(),
    /** `provisioning` | `applying` | `ready` | `stopped` | `failed` */
    status: text(),
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
      'managed_name_format_check',
      sql`(${table.name} IS NULL) OR (((char_length((${table.name})::text) >= 1) AND (char_length((${table.name})::text) <= 255)) AND ((${table.name})::text ~ '^[A-Za-z0-9 ._-]+$'::text))`,
    ),
    check(
      'managed_status_check',
      sql`status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed')`,
    ),
  ]
)
/**
 * One server participation (node) in a managed cluster (`managed`). Exactly
 * one `primary` per `managed_id` (partial unique); replicas use ordinals 2+.
 * Container fan-out uses `ordinal` on `(service_id, role='service', ordinal)`.
 */
export const node = pgTable(
  'node',
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
    metadata: jsonb(),
    options: jsonb(),
    managedId: uuid('managed_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `primary` | `replica` */
    role: text().default('primary').notNull(),
    readEligible: boolean('read_eligible').default(false).notNull(),
    /** 1-based member ordinal — mirrors the service-role container ordinal. */
    ordinal: integer().default(1).notNull(),
    /**
     * Resolved private path to the primary (`local` | `datacenter` | `vpn`).
     * Null when not yet resolved (or primary self).
     */
    replicationTransport: text('replication_transport'),
    /**
     * Host port published only on the member's private address for remote
     * replication + ProxySQL backend reachability. Null for single-member
     * clusters.
     */
    privatePort: integer('private_port'),
    /** Per-member observed status; same vocabulary as `managed.status` plus `needs_resync`. */
    status: text(),
  },
  (table) => [
    index('idx_node_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_node_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'node_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'node_server_id_server_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('uniq_node_primary')
      .on(table.managedId)
      .where(sql`${table.role} = 'primary'`),
    uniqueIndex('uniq_node_server_private_port')
      .on(table.serverId, table.privatePort)
      .where(sql`${table.privatePort} IS NOT NULL`),
    unique('uniq_node_managed_ordinal').on(table.managedId, table.ordinal),
    unique('uniq_node_managed_server').on(table.managedId, table.serverId),
    check(
      'node_role_check',
      sql`${table.role} IN ('primary','replica')`,
    ),
    check(
      'node_ordinal_positive_check',
      sql`${table.ordinal} >= 1`,
    ),
    check(
      'node_transport_check',
      sql`${table.replicationTransport} IS NULL OR ${table.replicationTransport} IN ('local','datacenter','vpn')`,
    ),
    check(
      'node_status_check',
      sql`status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed','needs_resync')`,
    ),
  ],
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
    /**
     * When set, this row is system-owned by a binding (materialized credentials).
     * Client PATCH/DELETE is refused; variable rows cascade when the binding is deleted.
     */
    bindingId: uuid('binding_id'),
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
    index('idx_variable_binding_id').using(
      'btree',
      table.bindingId.asc().nullsLast().op('uuid_ops'),
    ),
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
    foreignKey({
      columns: [table.bindingId],
      foreignColumns: [binding.id],
      name: 'variable_binding_id_binding_id_fk',
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
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    /**
     * User-facing display label (column renamed from `display_name`). Nullable
     * and not unique. Client JSON still exposes this field as `displayName`.
     */
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
    /**
     * Compose service key — derived from the compose document (project base +
     * environment overlay). Written only by reconcile (`reconcileServicesFromCompose`),
     * managed container allocation, and daemon-report container reconcile
     * (`ensureServicesForReportedContainers`) — never by a client request.
     * Unique per environment (`uniq_service_environment_compose_name`);
     * `name` itself is not unique and must not be assumed so.
     */
    composeServiceName: varchar('compose_service_name', { length: 255 }).notNull(),
  },
  (table) => [
    index('idx_service_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    /** Unique per environment. */
    uniqueIndex('uniq_service_environment_compose_name').on(
      table.environmentId,
      table.composeServiceName,
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'service_environment_id_environment_id_fk',
    }).onDelete('restrict'),
    check(
      'service_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * One row per participating `(environment, server)` in a deploy. Unique on
 * that pair; `server_id` RESTRICT mirrors `container.server_id`.
 */
export const deployment = pgTable(
  'deployment',
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
    /** Last failure message / planner warnings. */
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    serverId: uuid('server_id').notNull(),
    desiredGeneration: integer('desired_generation').default(0).notNull(),
    appliedGeneration: integer('applied_generation'),
    /** sha256 of that server's compiled runtime `compose.yaml`. */
    desiredHash: text('desired_hash'),
    status: text().default('pending').notNull(),
    /** No FK — mirrors `command.actor_id`. */
    lastCommandId: uuid('last_command_id'),
  },
  (table) => [
    unique('uniq_deployment_environment_server').on(table.environmentId, table.serverId),
    index('idx_deployment_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_deployment_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'deployment_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'deployment_server_id_server_id_fk',
    }).onDelete('restrict'),
    check(
      'deployment_status_check',
      sql`${table.status} IN ('pending','applying','applied','failed','draining')`,
    ),
    check(
      'deployment_generation_check',
      sql`${table.desiredGeneration} >= 0 AND (${table.appliedGeneration} IS NULL OR ${table.appliedGeneration} >= 0)`,
    ),
  ],
)
/**
 * One scheduled instance of a logical service. Never mint a `service` row per
 * replica — `slot` is 0-based (unlike `container.ordinal` / `node.ordinal`,
 * which are 1-based). A task is derived scheduling state: `service_id`
 * CASCADE so deleting a service drops its tasks rather than blocking.
 */
export const task = pgTable(
  'task',
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
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** 0-based replica slot (not 1-based like `container.ordinal`). */
    slot: integer().notNull(),
    generation: integer().default(0).notNull(),
    desiredState: text('desired_state').default('running').notNull(),
  },
  (table) => [
    unique('uniq_task_service_slot').on(table.serviceId, table.slot),
    index('idx_task_environment_generation').using(
      'btree',
      table.environmentId.asc(),
      table.generation.asc(),
    ),
    index('idx_task_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'task_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'task_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'task_server_id_server_id_fk',
    }).onDelete('restrict'),
    check('task_slot_nonnegative_check', sql`${table.slot} >= 0`),
    check(
      'task_desired_state_check',
      sql`${table.desiredState} IN ('running','stopped','removed')`,
    ),
  ],
)
/**
 * Server label source for `placement.constraints` (`node.labels.*`). Org is
 * derived through `server` — no `organization_id`, matching `container`.
 */
export const label = pgTable(
  'label',
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
    key: varchar({ length: 255 }).notNull(),
    value: varchar({ length: 255 }).default('').notNull(),
  },
  (table) => [
    unique('uniq_label_server_key').on(table.serverId, table.key),
    index('idx_label_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'label_server_id_server_id_fk',
    }).onDelete('cascade'),
    check(
      'label_key_format_check',
      sql`(char_length((${table.key})::text) >= 1) AND (char_length((${table.key})::text) <= 255) AND ((${table.key})::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text)`,
    ),
  ],
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
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    /** Optional pin into the org TLS library; null = Caddy tls internal (self-signed). */
    tlsId: uuid('tls_id'),
    /** Optional pin to a managed `ip` row for ingress addressing. */
    ipId: uuid('ip_id'),
    name: varchar({ length: 255 }),
    description: varchar('description', { length: 255 }),
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
      'hosting_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /**
     * Docker container id reported by the daemon after deploy. Null between
     * pre-allocation and the daemon's post-`compose up` report.
     */
    containerId: text('container_id'),
    containerName: text('container_name').notNull(),
    status: text('status').default('pending').notNull(),
    /**
     * `role='ingress'` rows always use `ordinal = 1` and are named
     * `<service.id>-in` via `ingressContainerNameFromService`.
     * `role='turbopanel'` is the platform `turbopanel-system` compose stack
     * (`database` / `queue` / `analytics`). `role='service'` is the ordinary
     * workload/engine replica. A service may hold N service replicas plus
     * exactly one ingress row.
     */
    role: text().default('service').notNull(),
    composeServiceName: text('compose_service_name').notNull(),
    /**
     * 1-based instance index of this container within its service; managed
     * engines always carry an ordinal. Unique with `service_id` so placement
     * changes re-home the same allocation rather than minting a second row.
     */
    ordinal: integer('ordinal').default(1).notNull(),
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
    uniqueIndex('uniq_container_server_container_id')
      .on(table.serverId, table.containerId)
      .where(sql`container_id IS NOT NULL`),
    uniqueIndex('uniq_container_service_role_ordinal').on(
      table.serviceId,
      table.role,
      table.ordinal,
    ),
    check('container_ordinal_positive_check', sql`ordinal >= 1`),
    check('container_role_check', sql`role IN ('service', 'ingress', 'turbopanel')`),
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
 * A principal is an account identity that can be attached to services — a
 * Linux (server) host account or a database engine user. Org is derived through
 * `assignment` → `service` (or `project` → `workspace` for project principals);
 * there is deliberately no `organization_id` column here. Host-account username
 * uniqueness is app-enforced per organization (trim + case-insensitive).
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
    /**
     * Holds `home` (`/srv/users/<username>`) plus a mirror of an optional
     * operator `uid`/`gid` override when set — never an instance-allocated id.
     */
    metadata: jsonb(),
    options: jsonb(),
  
    /** `system` (Linux/server host account) | `database` (engine account) */
    kind: text().notNull(),
    /** `server` | `postgres` | `mysql` | `redis` | `clickhouse` */
    provider: text().notNull(),
    /**
     * Account name. Allowlist mirrors POSIX/database account naming: starts
     * with a letter or underscore, then letters/digits/underscore/hyphen
     * (`^[A-Za-z_][A-Za-z0-9_-]*$`), 1–255 chars. Server principals additionally
     * enforce ≤ 32 at the API layer (daemon username limit).
     */
    username: varchar({ length: 255 }).notNull(),
    /**
     * Write-only credential. Stored as a `tpsecret.v<version>.…` envelope (instance
     * at-rest seal). Never returned on GET; delivery re-seals to `tpdaemon`
     * for the target daemon.
     */
    password: text(),
    /** Optional project scope for hosting principals. */
    projectId: uuid('project_id'),
    /** Optional managed-engine scope (cascade-deletes with the managed row). */
    managedId: uuid('managed_id'),
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
      sql`provider IN ('server', 'postgres', 'mysql', 'redis', 'clickhouse')`
    ),
    check(
      'principal_username_format_check',
      sql`(char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    // No global unique on `username`: the same account name (e.g. `postgres`,
    // `www-data`) legitimately recurs across different systems/services.
    // Server-provider host accounts are uniqueness-checked per org in app code.
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
/**
 * Join edge: managed-database principal ↔ consuming compose service.
 * Materializes system-owned `variable` rows (marked via `variable.binding_id`)
 * so DB credentials ride the existing deploy injection rail.
 *
 * FK direction: principal CASCADE (user/db gone → drop bindings); service
 * RESTRICT (a service still referenced by bindings cannot be deleted).
 */
export const binding = pgTable(
  'binding',
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
    metadata: jsonb(),
    options: jsonb(),
    principalId: uuid('principal_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    databaseName: varchar('database_name', { length: 255 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 64 }).default('DATABASE').notNull(),
    /** When true, also emit the unprefixed conventional engine keys (PG* / MYSQL_*). */
    emitEngineDefaults: boolean('emit_engine_defaults').default(true).notNull(),
  },
  (table) => [
    index('idx_binding_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_binding_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'binding_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'binding_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('uniq_binding_service_prefix').on(table.serviceId, table.keyPrefix),
    uniqueIndex('uniq_binding_service_engine_defaults')
      .on(table.serviceId)
      .where(sql`${table.emitEngineDefaults}`),
    check(
      'binding_key_prefix_format_check',
      sql`(char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`,
    ),
    check(
      'binding_database_name_format_check',
      sql`(char_length((database_name)::text) >= 1) AND (char_length((database_name)::text) <= 63) AND ((database_name)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`,
    ),
  ],
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
    metadata: jsonb(),
    options: jsonb(),
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
    /**
     * Compose auto-register idempotency: one `docker_volume` row per
     * `(environment_id, metadata.composeVolumeKey)` when the key is stamped.
     */
    uniqueIndex('uniq_storage_environment_compose_volume_key')
      .using(
        'btree',
        table.environmentId.asc().nullsLast().op('uuid_ops'),
        sql`(${table.metadata} ->> 'composeVolumeKey')`,
      )
      .where(
        sql`kind = 'docker_volume'
          AND environment_id IS NOT NULL
          AND COALESCE(metadata->>'composeVolumeKey', '') <> ''`,
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
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar({ length: 255 }),
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
      'team_name_format_check',
      sql`(name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))`
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
    metadata: jsonb(),
    options: jsonb(),
    name: varchar({ length: 255 }),
    email: varchar({ length: 255 }).notNull(),
    isEmailVerified: boolean('is_email_verified').default(false).notNull(),
    is2FaEnabled: boolean('is_2fa_enabled').default(false).notNull(),
    isDisabled: boolean('is_disabled').default(false).notNull(),
    role: text().default('user').notNull(),
  },
  (table) => [
    unique('user_email_unique').on(table.email),
    check(
      'user_name_format_check',
      sql`(name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))`
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
