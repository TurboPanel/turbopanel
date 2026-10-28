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
 *
 * Primary keys are UUIDv7 (`DEFAULT uuidv7()`, PostgreSQL 18+) under a
 * primary/standby model with one writable primary; sharded/distributed SQL is
 * out of scope. Guarded by `primary-key.test.ts` — see AGENTS.md (Multi-node
 * PostgreSQL model) before changing key strategy.
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  ENVIRONMENT_NAME_RE,
  FOLDER_NAME_RE,
  PROJECT_SLUG_RE,
  RESERVED_SCOPE_NAMES,
} from '../contracts/directory-names.ts'
import { cidr, inet } from './net-types.ts'

export const invitation = pgTable(
  'invitation',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    email: varchar({ length: 255 }).notNull(),
    /** `pending` → `accepted` | `revoked`; expiry is `expires_at`, compared at read. */
    status: text().notNull(),
    /** Intended access grants materialized on accept — see `InvitationGrantSpec`. */
    grants: jsonb(),
    /**
     * SHA-256 verifier of the secret emailed in the accept link (never the
     * secret itself, never returned by an API). Null for invitations created
     * before the landing page, which only the signed-in accept can use.
     */
    tokenHash: text('token_hash'),
  },
  (table) => [
    uniqueIndex('uniq_invitation_token_hash').using(
      'btree',
      table.tokenHash.asc().nullsLast().op('text_ops')
    ),
    index('idx_invitation_email').using('btree', table.email.asc().nullsLast().op('text_ops')),
    index('idx_invitation_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    index('idx_invitation_team_id').using('btree', table.teamId.asc().nullsLast().op('uuid_ops')),
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
    check('invitation_status_check', sql`status IN ('pending', 'accepted', 'revoked')`),
  ]
)
export const organization = pgTable(
  'organization',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    options: jsonb(),
    name: text(),
    nextLinuxId: integer('next_linux_id').default(30001).notNull(),
    /** Longest a deploy may run, in minutes (5 to 240); null means the default of 30. */
    deployTimeoutMinutes: integer('deploy_timeout_minutes'),
    /** Destination finished backups are copied to unless a cluster chooses otherwise. */
    backupDestinationId: uuid('backup_destination_id').references(
      (): AnyPgColumn => backupTarget.id,
      { onDelete: 'set null' }
    ),
  },
  (table) => [
    index('idx_organization_backup_destination_id').on(table.backupDestinationId),
    check(
      'organization_next_linux_id_check',
      sql`${table.nextLinuxId} >= 30001 AND ${table.nextLinuxId} <= 60001`
    ),
    check(
      'organization_deploy_timeout_minutes_check',
      sql`${table.deployTimeoutMinutes} IS NULL OR (${table.deployTimeoutMinutes} >= 5 AND ${table.deployTimeoutMinutes} <= 240)`
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: text(),
    /** `upload` | `lets_encrypt` | `self_signed` | `organization_ca` */
    source: text().notNull(),
    /** Leaf + intermediate chain PEM; null while LE `pending`. */
    certificatePem: text('certificate_pem'),
    /** Sealed `tpsecret` private key PEM; null while LE `pending` before keygen. */
    privateKeyPem: text('private_key_pem'),
    /** `ready` | `pending` | `expired` | `failed` | `revoked` | `managed` (Caddy ACME intent) */
    status: text().default('ready').notNull(),
    notAfter: timestamp('not_after', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    fingerprintSha256: text('fingerprint_sha256'),
    /**
     * Organization CA lifecycle: `active` | `retired` | `revoked`.
     * Null on non-CA library rows. `status` remains the row's own health.
     */
    caState: text('ca_state'),
    /** Monotonic per-org counter on Organization CA rows; null on non-CA rows. */
    caGeneration: integer('ca_generation'),
    /** Server whose Caddy issued the stored Let's Encrypt pair; null when none is stored. */
    issuedByServerId: uuid('issued_by_server_id'),
  },
  (table) => [
    index('idx_tls_issued_by_server_id').using(
      'btree',
      table.issuedByServerId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.issuedByServerId],
      foreignColumns: [server.id],
      name: 'tls_issued_by_server_id_server_id_fk',
    }).onDelete('set null'),
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
      .where(sql`${table.source} = 'organization_ca' AND ${table.caState} = 'active'`),
    index('idx_tls_organization_ca_generation')
      .on(table.organizationId, table.caGeneration)
      .where(sql`${table.source} = 'organization_ca'`),
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
    check(
      'tls_ca_state_check',
      sql`ca_state IS NULL OR ca_state IN ('active', 'retired', 'revoked')`
    ),
    check(
      'tls_ca_lifecycle_source_check',
      sql`(source = 'organization_ca' AND ca_state IS NOT NULL) OR (source <> 'organization_ca' AND ca_state IS NULL AND ca_generation IS NULL)`
    ),
    check(
      'tls_ca_generation_source_check',
      sql`ca_generation IS NULL OR source = 'organization_ca'`
    ),
    check(
      'tls_ca_generation_required_check',
      sql`ca_state IS NULL OR ca_state = 'revoked' OR ca_generation IS NOT NULL`
    ),
    // Mirrors `TlsStatus` (src/lib/tls/types.ts) — pinned by enum-checks.test.ts.
    check(
      'tls_status_check',
      sql`status IN ('ready', 'pending', 'expired', 'failed', 'revoked', 'automatic')`
    ),
  ]
)
/**
 * Durable Organization CA rotation journal (one in-flight rotation per org).
 */
export const changeover = pgTable(
  'changeover',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    fromCaGeneration: integer('from_ca_generation').default(0).notNull(),
    toCaGeneration: integer('to_ca_generation').default(0).notNull(),
    /** `in_progress` | `awaiting_retire` | `completed` | `failed` */
    state: text().notNull(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Per-server / per-cluster fan-out rows (`ingress` | `apply`). */
    results: jsonb().default([]),
    /** Set when fan-out finishes (`awaiting_retire`); the sweep retires the old generation after it. */
    retireBy: timestamp('retire_by', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_changeover_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'changeover_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_changeover_inflight_organization')
      .on(table.organizationId)
      .where(sql`${table.state} = 'in_progress'`),
    check(
      'changeover_state_check',
      sql`${table.state} IN ('in_progress','awaiting_retire','completed','failed')`
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
    name: text(),
    publicKey: text('public_key').notNull(),
    credentialId: text('credential_id').notNull(),
    counter: bigint('counter', { mode: 'number' }).default(0).notNull(),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    isBackedUp: boolean('is_backed_up').notNull(),
    transports: text(),
  },
  (table) => [
    unique('uniq_passkey_credential_id').on(table.credentialId),
    index('idx_passkey_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'passkey_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Logical routing domain — not a building — of mutually routable private
 * subnets (IPv4 and/or IPv6); optional — a server may belong to zero or many
 * datacenters via `ip` pins. `options` mirrors `organization.options` for
 * `defaultServerTimezone` / `enforceServerTimezone` (parsed by
 * `src/features/datacenters/datacenter-options.ts`); the routing policy lives in
 * real columns: `priority` (integer, lower wins, default 100), `trusted`
 * (default true; false when the L2 is not under the operator's control) and
 * `address_preference`, plus the optional `kind` of network. Must stay declared before `server` (same
 * rule as `license`).
 */
export const datacenter = pgTable(
  'datacenter',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    name: text(),
    description: text('description'),
    /** Routing-ladder rank among a server's datacenters, 0..1000, lower wins. */
    priority: integer().default(100).notNull(),
    /** Whether the operator controls the datacenter's L2; `false` keeps server-to-server traffic off it. */
    isTrusted: boolean('is_trusted').default(true).notNull(),
    /** Address family tried first among a server's pins here: `ipv6` or `ipv4`. */
    addressPreference: text('address_preference').default('ipv6').notNull(),
    /** What the network is: `lan`, `backplane` or `provider_private`; NULL means the operator never said. */
    kind: text(),
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
    check('datacenter_priority_check', sql`priority >= 0 AND priority <= 1000`),
    check('datacenter_address_preference_check', sql`address_preference IN ('ipv6', 'ipv4')`),
    check(
      'datacenter_kind_check',
      sql`kind IS NULL OR kind IN ('lan', 'backplane', 'provider_private')`
    ),
  ]
)
/**
 * Platform-global billed offering: a ladder label (`S1`…`S7`, `SX`) bound
 * to the payment provider's Product. Everything a tier *entitles* lives in
 * code (`src/features/tiers/ladder.ts`, keyed by `label`); the row holds only
 * what the code cannot know — which provider product the label bills
 * against — plus a cached display price. Rows are deactivated
 * (`is_active = false`), never deleted. No `organization_id`: every org
 * sees the same catalogue. Defined before `server` so
 * `server.assigned_tier_id` can reference it.
 */
export const tier = pgTable(
  'tier',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** `"S1"`…`"S7"`, `"SX"` — the key into the in-code ladder; unique. */
    label: text().notNull(),
    /** Copied from the ladder on insert, never from a request; orders tiers and decides upgrade vs downgrade. */
    rank: integer().notNull(),
    /** `stripe` only — Apple was dropped before the first tag (2026-09-12). Matches `payer_provider_check`. */
    provider: text().default('stripe').notNull(),
    /**
     * The provider's Product this tier bills against, chosen from the
     * provider's catalogue and verified before the row is written. Null on
     * a custom / SX row, which is therefore never purchasable.
     */
    providerProductId: text('provider_product_id'),
    /**
     * Display cache of the product's default price (minor units), written
     * on verify and refreshed by the provider's price webhooks. Nothing
     * does arithmetic on it: the provider owns the price.
     */
    priceCents: integer('price_cents'),
    /** Display cache beside `price_cents`; lower-case ISO code. */
    currency: text(),
    isCustom: boolean('is_custom').default(false).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
  },
  (table) => [
    uniqueIndex('uniq_tier_label').on(table.label),
    // Rank decides upgrade-versus-downgrade direction and the greedy
    // assignment order, so a tie would make both undefined.
    uniqueIndex('uniq_tier_rank').on(table.rank),
    // At most one tier per provider product: the product→tier map the
    // projection builds is keyed on this pair, and a duplicate would resolve
    // to whichever row it happened to see last — silently moving entitlement.
    uniqueIndex('uniq_tier_provider_product')
      .on(table.provider, table.providerProductId)
      .where(sql`${table.providerProductId} IS NOT NULL`),
    check('tier_provider_check', sql`provider IN ('stripe')`),
  ]
)
/**
 * The self-hosted entitlement grant — how a free instance holds licenses,
 * promoted out of a `setting` row keyed `SELF_HOSTED_GRANT:<orgId>`
 * (schema-child-tables, Road-to-0.1.x). See `lib/tiers/self-hosted-grant.ts`
 * for what it is and why; `lib/tiers/self-hosted-grant-records.ts` for the
 * read/write API, unchanged by this move. Exactly 0-or-1 row per
 * organization — enforced structurally now via the unique index, where the
 * old `setting.key` string only enforced it by construction.
 *
 * Physical name `allowance`, not `grant` — the `grant` table is the
 * unrelated ACL access-grant (`client/authz/access-grants.ts`), and the
 * table-naming guard (`table-naming.test.ts`) requires one lower-case word,
 * ruling out `self_hosted_grant`.
 *
 * `quantity` never sits at 0: `writeSelfHostedGrant` deletes the row
 * instead, matching the old "quantity 0 means delete the setting key"
 * behavior exactly.
 */
export const allowance = pgTable(
  'allowance',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** Always the `SX` custom-rung row (`ensureCustomTierRow`), never purchasable. */
    tierId: uuid('tier_id').notNull(),
    quantity: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_allowance_organization').on(table.organizationId),
    index('idx_allowance_tier_id').on(table.tierId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'allowance_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tierId],
      foreignColumns: [tier.id],
      name: 'allowance_tier_id_tier_id_fk',
    }).onDelete('restrict'),
    check('allowance_quantity_check', sql`quantity >= 1`),
  ]
)
/**
 * Enrolled host. Membership in datacenters is **not** a home FK here — a
 * server may pin into many sites via `ip` rows (`scope='datacenter'` +
 * `server_id` + `datacenter_id`).
 */
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id'),
    name: text(),
    hostname: varchar('hostname', { length: 255 }),
    /**
     * Derived HMAC of the host machine-id (not the raw value, not a sealed
     * secret). Deterministic so it can be equality-matched and echoed into
     * signed enroll/auth payloads.
     */
    machineKey: text('machine_key'),
    /**
     * Daemon-reported OS from `/etc/os-release`. Raspberry Pi OS (including
     * 64-bit `ID=debian` + `/etc/rpi-issue`) is stored as
     * `os_id = raspberry-pi-os`.
     */
    osId: varchar('os_id', { length: 255 }),
    osFamily: varchar('os_family', { length: 32 }),
    osVersion: varchar('os_version', { length: 64 }),
    osCodename: varchar('os_codename', { length: 64 }),
    osPrettyName: varchar('os_pretty_name', { length: 255 }),
    osArchitecture: varchar('os_architecture', { length: 64 }),
    /**
     * Machine class for metrics capability-plan resolution (`physical` |
     * `virtual`). NULL means undeclared: ingest infers it from the recorded
     * topology each sample and writes back `physical` once the host proves
     * it by discovering hardware sensors — never `virtual`, which is only
     * absence of proof and would stop a sensor found by a later topology
     * generation from promoting the host. `PATCH /servers/:id` pins either
     * value (or clears the pin with null).
     */
    machineClass: text('machine_class'),
    /**
     * Who set `machine_class`: `detected` (ingest wrote it back from the
     * topology) or `operator` (`PATCH /servers/:id` pinned or cleared it).
     * NULL while `machine_class` is NULL. Ingest never overwrites `operator`.
     */
    machineClassSource: text('machine_class_source'),
    /**
     * Daemon-reported host timezone (IANA). Operator override lives on
     * `server.options.timezone`.
     */
    timezone: varchar('timezone', { length: 64 }),
    isTimeSyncEnabled: boolean('is_time_sync_enabled'),
    /** jsonb array of `{ host, fallback? }`. */
    ntpServers: jsonb('ntp_servers'),
    ntpLastSyncedAt: timestamp('ntp_last_synced_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Fleet liveness flag. Tri-state `online|offline|unknown` is derived from
     * `is_connected` + `status_changed_at` (never stored). API JSON still
     * serializes as `connected`.
     */
    /**
     * The tier an organization manager assigned this server (license-tier
     * route, or an owner-named upgrade or downgrade). On self-hosted, the top
     * tier is filled into a licensed server that has none. Never recomputed;
     * null until assigned.
     */
    assignedTierId: uuid('assigned_tier_id'),
    /**
     * Written in step with `assigned_tier_id` by the manager route, for the
     * console's picked label; never read to place a server.
     */
    preferredTierId: uuid('preferred_tier_id'),
    isConnected: boolean('is_connected').default(false).notNull(),
    /**
     * Last status transition (`is_connected` flip). Feeds derived `connectedAt`
     * (when connected) / `offlineAt` (when not). `online|offline|unknown` is
     * derived, never stored.
     */
    statusChangedAt: timestamp('status_changed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Sparse `{ projection? }` — the daemon key lives in the `key` table
     * (schema-child-tables, Road-to-0.1.x), not here; status lives in
     * dedicated columns.
     */
    daemon: jsonb(),
    /**
     * Mirrors validated `options.hosting.enabled` (schema-sql-keys,
     * Road-to-0.1.x): `system/reconcile.ts` filters ingress/hosting-inventory
     * decisions on this value, once in raw SQL and once via
     * `parseServerOptions` on an app-level row. `options.hosting.enabled`
     * stays the parsed/validated source of truth (written by the one PATCH
     * route that accepts it); this column exists so both reads can use a
     * real boolean instead of a jsonb path. NULL reads as "not set" — same
     * as absent `options.hosting`.
     */
    isHostingEnabled: boolean('is_hosting_enabled'),
    /**
     * Latest hardware layout the daemon reported (`generation`,
     * `bootGeneration`, `snapshot`, `appliedAt`, `updatedAt`, `changes`), at
     * most 64 KiB, rewritten at most once per cooldown. Overwritten in
     * place: there is no history. Never selected by list, detail or auth reads.
     */
    hardware: jsonb(),
    /**
     * Latest resolved metrics capability plan (`generation`, `planHash`,
     * `plan`, `appliedAt`). Overwritten in place; recomputable from the box
     * size and the hardware. Never selected by list, detail or auth reads.
     */
    capability: jsonb(),
    /** Why the host is offline, from the daemon projection (`projection.offlineReason`). */
    offlineReason: text('offline_reason'),
    /** Commit of the daemon build running on the host (`projection.daemonBuild.commit`). */
    daemonCommit: text('daemon_commit'),
    /** When the running daemon build was built (`projection.daemonBuild.builtAt`). */
    daemonBuiltAt: timestamp('daemon_built_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Daemon self-update state (`projection.update.status`). */
    daemonUpdateStatus: text('daemon_update_status'),
    /** Since when a managed-database external-access change waits for this server (self-hosted sweep). */
    externalAccessPendingAt: timestamp('external_access_pending_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * The datacenter whose network this server prefers for its traffic when it
     * belongs to several. NULL means no preference (priority order decides).
     * Set null if the datacenter is deleted.
     */
    preferredDatacenterId: uuid('preferred_datacenter_id'),
  },
  (table) => [
    index('idx_server_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    unique('uniq_server_machine_key').on(table.machineKey),
    index('idx_server_connected')
      .on(table.id)
      .where(sql`${table.isConnected}`),
    index('idx_server_offline')
      .on(table.statusChangedAt.desc())
      .where(sql`${table.isConnected} = false`),
    index('idx_server_updating')
      .on(table.id)
      .where(sql`${table.daemonUpdateStatus} = 'updating'`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'server_organization_id_organization_id_fk',
    }).onDelete('restrict'),
    index('idx_server_assigned_tier_id').using(
      'btree',
      table.assignedTierId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.assignedTierId],
      foreignColumns: [tier.id],
      name: 'server_assigned_tier_id_tier_id_fk',
    }).onDelete('set null'),
    index('idx_server_preferred_tier_id').using(
      'btree',
      table.preferredTierId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.preferredTierId],
      foreignColumns: [tier.id],
      name: 'server_preferred_tier_id_tier_id_fk',
    }).onDelete('set null'),
    index('idx_server_preferred_datacenter_id').using(
      'btree',
      table.preferredDatacenterId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.preferredDatacenterId],
      foreignColumns: [datacenter.id],
      name: 'server_preferred_datacenter_id_datacenter_id_fk',
    }).onDelete('set null'),
    check('server_machine_class_check', sql`${table.machineClass} IN ('physical', 'virtual')`),
    check(
      'server_machine_class_source_check',
      sql`machine_class_source IN ('detected', 'operator')`
    ),
    check(
      'server_os_architecture_check',
      sql`os_architecture IS NULL OR os_architecture IN ('x86_64', 'aarch64')`
    ),
    check('server_offline_reason_check', sql`offline_reason IN ('disconnect', 'sweep_stale')`),
    check(
      'server_daemon_update_status_check',
      sql`daemon_update_status IN ('idle', 'updating', 'done', 'failed', 'expired')`
    ),
  ]
)
/**
 * The server's daemon identity — the Ed25519 keypair a daemon enrolls with,
 * one row per server (schema-child-tables, Road-to-0.1.x — promoted out of
 * `server.daemon.key`, formerly read-modify-written by two uncoordinated
 * jsonb writers: `authn/server-identity-db.ts`'s `updateServerDaemonState`
 * and `cell/postgres-projection.ts`'s `projectServerDaemon`. A daemon
 * heartbeat projecting between a revoke's read and write could silently
 * un-revoke a key that was just revoked — a real lost-update race, not just
 * staleness. Moving the key to its own table with single-column writers
 * closes it by construction: `projectServerDaemon` no longer composes key
 * data into its jsonb patch at all, so it cannot clobber it.
 *
 * `UNIQUE(fingerprint)` globally is new enforced behavior the jsonb never
 * had — safe to add because the invariant is unambiguous: two servers
 * sharing a daemon key is an authn hole, never a legitimate state.
 * `UNIQUE(server_id)` matches "replace on re-enroll", the existing
 * behavior — enrolling again overwrites the prior key outright, no history
 * kept for MVP.
 */
export const key = pgTable(
  'key',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    algorithm: text().notNull(),
    publicJwk: jsonb('public_jwk').notNull(),
    fingerprint: text().notNull(),
    revokedAt: timestamp('revoked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastUsedAt: timestamp('last_used_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    uniqueIndex('uniq_key_server').on(table.serverId),
    uniqueIndex('uniq_key_fingerprint').on(table.fingerprint),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'key_server_id_server_id_fk',
    }).onDelete('cascade'),
    check('key_algorithm_check', sql`algorithm = 'Ed25519'`),
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** Set on first successful enroll — one-shot seat latch. */
    serverId: uuid('server_id'),
    name: text(),
    /** Argon2id PHC hashed token — same format as account.password */
    token: text().notNull(),
    /** Soft-delete */
    revokedAt: timestamp('revoked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Tier a manager chose in Add Server; the server that enrolls with this key takes it. */
    tierId: uuid('tier_id'),
    /** An unused key stops working (and stops holding a license) at this time; null never expires. */
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
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
    /** Plain, because a partial unique index cannot serve the cascade lookup from `server`. */
    index('idx_license_server_id').on(table.serverId),
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
    index('idx_license_tier_id').on(table.tierId),
    foreignKey({
      columns: [table.tierId],
      foreignColumns: [tier.id],
      name: 'license_tier_id_tier_id_fk',
    }).onDelete('set null'),
  ]
)
/**
 * Billing projection — who pays.
 *
 * **Stripe owns money, Postgres owns entitlement.** These rows are a
 * projection of the provider's customer, written only by the webhook ingress
 * (`src/webhook/billing/stripe.ts` → `src/features/billing/billing-records.ts`), so
 * every entitlement read — license minting, tier placement, metrics
 * truncation on every sample — is a local query and never a provider call.
 *
 * `payer` is polymorphic over its subject: an organization *or* a user, never
 * both and never neither (`payer_subject_check`). That is the point at which
 * an in-app subscription (Apple requires one to belong to a person) stays
 * expressible without rewriting every FK that points at billing later.
 * Columns are `provider_*`, never `stripe_*` — naming discipline, not a second
 * integration; `payer_provider_check` names the providers that may appear.
 */
export const payer = pgTable(
  'payer',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Exactly one of `organization_id` / `user_id` — see `payer_subject_check`. */
    organizationId: uuid('organization_id'),
    userId: uuid('user_id'),
    /** `stripe` today; `apple` reserved. */
    provider: text().notNull(),
    /** Provider-side customer id (Stripe `cus_…`). */
    providerCustomerId: text('provider_customer_id').notNull(),
    /** Tax id as the provider reports it; presence only, never validated here. */
    taxId: text('tax_id'),
  },
  (table) => [
    index('idx_payer_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_payer_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    // Exactly one subject. `<>` on the two null-tests is XOR: a row with both
    // or neither would make every downstream join ambiguous, and retrofitting
    // that later means rewriting every FK that points at billing.
    check(
      'payer_subject_check',
      sql`(${table.organizationId} IS NULL) <> (${table.userId} IS NULL)`
    ),
    // `provider_*` columns, never `stripe_*`; this is the list of providers a
    // row may name, not a second integration.
    check('payer_provider_check', sql`provider IN ('stripe')`),
    // The webhook upsert conflict target: one row per provider customer.
    uniqueIndex('uniq_payer_provider_customer').on(table.provider, table.providerCustomerId),
    // One payer per provider per subject, on whichever side is set.
    uniqueIndex('uniq_payer_organization_provider')
      .on(table.organizationId, table.provider)
      .where(sql`${table.organizationId} IS NOT NULL`),
    uniqueIndex('uniq_payer_user_provider')
      .on(table.userId, table.provider)
      .where(sql`${table.userId} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'payer_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'payer_user_id_user_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * One provider subscription for a `payer`.
 *
 * **No CHECK on `status`.** Stripe adds statuses; a CHECK would turn a
 * Stripe product change into a webhook that 500s. The value is narrowed in
 * code (`src/features/billing/billing-records.ts`) instead.
 */
export const subscription = pgTable(
  'subscription',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    payerId: uuid('payer_id').notNull(),
    /** Provider-side subscription id (Stripe `sub_…`) — the upsert conflict target. */
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    /**
     * TurboPanel's own status vocabulary — Stripe's eight, plus `unknown`
     * for any value the projection has never seen. Checked. The raw provider
     * value is beside it in `provider_status`, so a Stripe vocabulary change
     * lands as `unknown` + the verbatim string rather than a refused webhook.
     * Mirrors `KNOWN_SUBSCRIPTION_STATUSES` (src/features/billing/billing-records.ts).
     */
    status: text().notNull(),
    /** Provider status verbatim, never interpreted (`active`, `past_due`, …). */
    providerStatus: text('provider_status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Provider schedule id when a downgrade is parked on a schedule. */
    scheduleId: text('schedule_id'),
    /** Grace clock (next phase): entitlement survives until this moment. */
    graceExpiresAt: timestamp('grace_expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** First moment the provider reported the subscription past due. */
    pastDueSince: timestamp('past_due_since', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_subscription_payer_id').using(
      'btree',
      table.payerId.asc().nullsLast().op('uuid_ops')
    ),
    uniqueIndex('uniq_subscription_provider_id').on(table.providerSubscriptionId),
    foreignKey({
      columns: [table.payerId],
      foreignColumns: [payer.id],
      name: 'subscription_payer_id_payer_id_fk',
    }).onDelete('cascade'),
    check(
      'subscription_status_check',
      sql`status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown')`
    ),
  ]
)
/**
 * One line of a subscription: `quantity` seats at one `tier`.
 *
 * Physical table name is the single lower-case word `seat` (repo rule — see
 * `src/db/table-naming.test.ts`); the export keeps the provider's
 * `subscriptionItem` vocabulary because that is what the webhook projects.
 * A row *is* N seats at one tier, and `seat` reads correctly beside
 * `license`.
 */
export const subscriptionItem = pgTable(
  'seat',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    tierId: uuid('tier_id').notNull(),
    /** Provider-side subscription item id (Stripe `si_…`). */
    providerItemId: text('provider_item_id').notNull(),
    /**
     * The provider price the item bills at (Stripe `price_…`), as projected
     * from the item itself — the price a mutation restates when it rewrites
     * `items[]` or a schedule phase. A tier knows its product, not its
     * price; the price lives here because it is the item's, not the tier's.
     * The one write path (`replaceSubscriptionItems`) always provides it —
     * `ProviderSubscriptionItem.providerPriceId` is non-optional at the type
     * level. NOT NULL pre-tag (schema-constraints, Road-to-0.1.x): every
     * database is disposable, so the earlier "nullable for backfill" window
     * this column was added under no longer needs protecting.
     */
    providerPriceId: text('provider_price_id').notNull(),
    quantity: integer().notNull(),
  },
  (table) => [
    index('idx_seat_tier_id').using('btree', table.tierId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('uniq_seat_provider_item').on(table.providerItemId),
    // The reconciliation invariant compares seats to licenses *per tier*, so
    // two rows for one tier on one subscription must be impossible.
    uniqueIndex('uniq_seat_subscription_tier').on(table.subscriptionId, table.tierId),
    foreignKey({
      columns: [table.subscriptionId],
      foreignColumns: [subscription.id],
      name: 'seat_subscription_id_subscription_id_fk',
    }).onDelete('cascade'),
    // A tier a seat once counted against must stay readable.
    foreignKey({
      columns: [table.tierId],
      foreignColumns: [tier.id],
      name: 'seat_tier_id_tier_id_fk',
    }).onDelete('restrict'),
  ]
)
export const command = pgTable(
  'command',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    serverId: uuid('server_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    name: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().default(0).notNull(),
    /**
     * Small, non-secret identifier bag (`managedId`, `environmentId`,
     * `generation`, …) kept on the permanent row so UI/projection reads never
     * need the daemon execution payload. Never put secrets, compose YAML,
     * credentials, or TLS material here.
     */
    context: jsonb(),
    /** Bounded daemon result summary (was `result`). */
    resultSummary: jsonb('result_summary'),
    /**
     * Latest `command-progress` payload from the daemon (`CommandProgress`,
     * `src/contracts/cell-protocol.ts`): the step plan and where it stands.
     * Null until the daemon reports one; finalised on the terminal transition.
     */
    progress: jsonb(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    queuedAt: timestamp('queued_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    dispatchStartedAt: timestamp('dispatch_started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    sentAt: timestamp('sent_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    ackedAt: timestamp('acked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * `metadata.managedDestroyGate.gateId`, promoted out of jsonb
     * (schema-sql-keys, Road-to-0.1.x): `loadManagedDestroyGateCommands`
     * filters every gated-replica-destroy completion on this value with no
     * index today. `memberIds` / `followups` stay in `metadata` — only the
     * filtered scalar moves.
     */
    managedDestroyGateId: text('managed_destroy_gate_id'),
    /**
     * Organization of the server, copied at insert (the activity feed and any
     * org-wide command list filter on it). Kept when the server is deleted
     * only as NULL: the row itself cascades with the server.
     */
    organizationId: uuid('organization_id'),
    /**
     * Environment a deploy, lifecycle or stop command was issued for (was
     * `context->>'environmentId'`). Set null when the environment is deleted.
     */
    environmentId: uuid('environment_id'),
    /**
     * Managed cluster the command acts on (was `context->>'managedId'`). Set
     * null when the cluster is deleted.
     */
    managedId: uuid('managed_id'),
  },
  (table) => [
    index('idx_command_managed_destroy_gate_id')
      .using('btree', table.managedDestroyGateId.asc().nullsLast().op('text_ops'))
      .where(sql`${table.managedDestroyGateId} IS NOT NULL`),
    /** The per-server command list: newest first, with the id as the tie-break so no sort is needed. */
    index('idx_command_server_recent').using(
      'btree',
      table.serverId.asc(),
      table.createdAt.desc(),
      table.id.desc()
    ),
    /**
     * Rows still moving: the stale-command reaper and the open-command probes
     * walk only these. The status list is repeated literally in the queries so
     * the planner can match the predicate.
     */
    index('idx_command_open')
      .using('btree', table.status.asc(), table.updatedAt.asc())
      .where(sql`${table.status} IN ('queued', 'dispatching', 'sent', 'acked', 'running')`),
    /** Open commands of one managed cluster (failover, destroy, TLS rotation lookups). */
    index('idx_command_managed')
      .using('btree', table.managedId.asc())
      .where(
        sql`${table.managedId} IS NOT NULL AND ${table.status} IN ('queued', 'dispatching', 'sent', 'acked', 'running')`
      ),
    /** The organization activity feed: deploys, lifecycle and stops, open or recently failed. */
    index('idx_command_feed')
      .using('btree', table.organizationId.asc(), table.createdAt.desc(), table.id.desc())
      .where(
        sql`${table.name} IN ('environment.deploy', 'environment.lifecycle', 'environment.stop') AND ${table.status} IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'failed', 'timed_out')`
      ),
    /**
     * The organization activity feed with every outcome (succeeded and
     * cancelled too): deploys, lifecycle and stops of one organization, newest
     * first. Partial on the name only, written literally as the feed query
     * writes it.
     */
    index('idx_command_activity')
      .using('btree', table.organizationId.asc(), table.createdAt.desc(), table.id.desc())
      .where(
        sql`${table.name} IN ('environment.deploy', 'environment.lifecycle', 'environment.stop')`
      ),
    /**
     * Backs the per-minute reconcile sweeps' "has this server ever (or since
     * its last connect) been sent a `<x>.reconcile`" EXISTS probes, which
     * otherwise walk the server's whole command history. Not partial on
     * purpose: the sweeps bind the command name as a parameter, and a generic
     * plan cannot use a partial index whose predicate it cannot see.
     */
    index('idx_command_server_id_name_created_at').using(
      'btree',
      table.serverId.asc(),
      table.name.asc(),
      table.createdAt.desc()
    ),
    /**
     * Backs the environment deploy-history read
     * (`GET /environments/:id/deployments`). Deploy history is sourced from
     * the append-only `command` table — one row per attempt — not from
     * `deployment`, which is an upsert-per-(environment, server) current-state
     * table. Partial + expression so it stays small: only
     * `environment.deploy` rows, keyed on `environment_id`.
     */
    index('idx_command_deploy')
      .using('btree', table.environmentId.asc(), table.createdAt.desc(), table.id.desc())
      .where(sql`${table.name} = 'environment.deploy'`),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'command_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'command_organization_id_organization_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'command_environment_id_environment_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'command_managed_id_managed_id_fk',
    }).onDelete('set null'),
    // Mirror `COMMAND_STATUSES` / `COMMAND_ACTOR_TYPES` (src/features/commands/types.ts) —
    // pinned by enum-checks.test.ts.
    check(
      'command_status_check',
      sql`status IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')`
    ),
    check('command_actor_type_check', sql`actor_type IN ('user', 'system')`),
  ]
)
/**
 * Daemon execution payload for a command (`dispatch`) — the only place
 * secret-bearing command input lives. Written in the same transaction as its `command` row,
 * read once by the consumer immediately before dispatch, deleted as soon as the
 * command succeeds, and retained ~24h (`expires_at`) after a terminal failure
 * for debugging. Expired rows are removed by the shared maintenance sweep.
 */
export const dispatch = pgTable(
  'dispatch',
  {
    commandId: uuid('command_id').primaryKey().notNull(),
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    payload: jsonb().notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_dispatch_expires_at').using('btree', table.expiresAt.asc()),
    foreignKey({
      columns: [table.commandId],
      foreignColumns: [command.id],
      name: 'dispatch_command_id_command_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * One instance-wide upgrade run. At most one row may be `pending` or
 * `running` (`uniq_upgrade_active` — a partial unique on a constant, because
 * there is no organization column to scope the way `uniq_changeover_inflight_organization`
 * does). `counts` is the summary the orchestrator writes when the run
 * finishes, so history remains after step rows are pruned.
 */
export const upgrade = pgTable(
  'upgrade',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** `{ daemon?, instance?, ui? }` each `{ version, commit, buildId, builtAt, pinnedManifestUrl }`. */
    target: jsonb(),
    preflight: jsonb(),
    source: text().notNull(),
    channel: text().notNull(),
    status: text().notNull().default('pending'),
    phase: text(),
    startedBy: uuid('started_by'),
    /** Snapshot of upgrade settings at run start. */
    batchPolicy: jsonb('batch_policy'),
    counts: jsonb(),
    error: text(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    uniqueIndex('uniq_upgrade_active')
      .on(sql`(true)`)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index('idx_upgrade_started_by').on(table.startedBy),
    index('idx_upgrade_created_at').on(table.createdAt.desc()),
    foreignKey({
      columns: [table.startedBy],
      foreignColumns: [user.id],
      name: 'upgrade_started_by_user_id_fk',
    }).onDelete('set null'),
    // Mirror UPGRADE_SOURCES / UPGRADE_STATUSES / UPGRADE_PHASES
    // (src/features/upgrades/vocabulary.ts) — pinned by enum-checks.test.ts.
    check('upgrade_source_check', sql`source IN ('manual', 'auto', 'server')`),
    check(
      'upgrade_status_check',
      sql`status IN ('pending', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled')`
    ),
    check(
      'upgrade_phase_check',
      sql`phase IS NULL OR phase IN ('colocated_daemon', 'control_plane', 'fleet')`
    ),
  ]
)
/**
 * One daemon or instance install on one server inside an {@link upgrade} run.
 * Physical name `stage`. Active steps are indexed for the
 * retry scan; terminal rows are pruned by `pruneUpgradeHistory`.
 */
export const stage = pgTable(
  'stage',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    upgradeId: uuid('upgrade_id').notNull(),
    serverId: uuid('server_id').notNull(),
    unit: text().notNull(),
    /** Which part of the run the step belongs to: the colocated daemon first, then the control plane, then the fleet. */
    phase: text().notNull().default('fleet'),
    batchIndex: integer('batch_index').default(0).notNull(),
    status: text().notNull().default('pending'),
    requestId: text('request_id'),
    attempts: integer().default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    fromVersion: text('from_version'),
    toVersion: text('to_version'),
    fromCommit: text('from_commit'),
    toCommit: text('to_commit'),
    statusChangedAt: timestamp('status_changed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    detail: jsonb(),
    /** First dispatch of this step; NULL until it is sent (and on rows written before the column). */
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** When the step reached a terminal status; cleared again by a retry. */
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_stage_upgrade_status').on(table.upgradeId, table.status),
    index('idx_stage_upgrade_server').on(table.upgradeId, table.serverId),
    index('idx_stage_upgrade_phase').on(
      table.upgradeId,
      table.phase,
      table.batchIndex,
      table.status
    ),
    index('idx_stage_server_created').on(table.serverId, table.createdAt.desc()),
    index('idx_stage_active_next_attempt')
      .on(table.status, table.nextAttemptAt)
      .where(
        sql`${table.status} IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying')`
      ),
    foreignKey({
      columns: [table.upgradeId],
      foreignColumns: [upgrade.id],
      name: 'stage_upgrade_id_upgrade_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'stage_server_id_server_id_fk',
    }).onDelete('cascade'),
    // Mirror UPGRADE_STEP_UNITS / UPGRADE_STEP_STATUSES
    // (src/features/upgrades/vocabulary.ts) — pinned by enum-checks.test.ts.
    check('stage_unit_check', sql`unit IN ('daemon', 'instance')`),
    check('stage_phase_check', sql`phase IN ('colocated_daemon', 'control_plane', 'fleet')`),
    check(
      'stage_status_check',
      sql`status IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying', 'done', 'failed', 'rolled_back', 'needs_attention', 'skipped')`
    ),
  ]
)
/**
 * Org-owned network registry: datacenter site CIDRs (`kind = 'datacenter'`;
 * a datacenter may own multiple CIDR rows), external Docker registrations
 * (`kind = 'docker'`, optional `server_id`), TurboFabric logical spanning
 * networks (`kind = 'compose'`), the org-wide managed-engine network
 * (`kind = 'managed'`), and operator-declared **reserved** ranges
 * (`kind = 'reserved'`).
 *
 * `reserved` rows are org-only (no datacenter/server/environment scope) and
 * always carry a CIDR: they name ranges TurboPanel must never allocate from or
 * accept elsewhere (a corporate VPN, an upstream transit block, …). They are
 * operator data — renamable and re-rangeable — and every CIDR write goes
 * through `src/features/net/cidr-collisions.ts`, which treats them as hard
 * collisions (`cidr_overlaps_reserved`); the fabric allocators exclude them.
 *
 * `managed` is platform-allocated, never operator-created: at most one row per
 * organization (`uniq_network_organization_managed`), no datacenter/server/
 * environment scope and no CIDR — the Docker network name lives in
 * `options.dockerNetworkName` and is the row's own bare UUID.
 */
export const network = pgTable(
  'network',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    serverId: uuid('server_id'),
    /**
     * Optional pin for `kind = 'compose'` logical spanning networks
     * (null = org-shared). `AnyPgColumn` breaks the same kind of forward
     * reference `project.repository_id` already uses below — `environment`
     * is declared later in this file. `set null` matches
     * `purgeEnvironmentComposeNetworks`, which the environment-delete route
     * already calls first; `system/hierarchy.ts`'s delete path does not call
     * it, so this constraint is also what makes that path leave a graceful
     * org-shared network row instead of an orphaned reference (schema-
     * constraints, Road-to-0.1.x).
     */
    environmentId: uuid('environment_id').references((): AnyPgColumn => environment.id, {
      onDelete: 'set null',
    }),
    kind: text().notNull(),
    cidr: cidr(),
    /** Stays `varchar(255)` (schema-text-types audit, 2026-09-16): `fabric-records.ts` writes a compose `networks.<key>` straight from the operator's document with no length check — the column is that write's only guard. */
    name: varchar({ length: 255 }),
    /**
     * `kind = 'compose'` idempotency key (the Compose network's own key in
     * the document), promoted out of `options.composeKey` (schema-sql-keys,
     * Road-to-0.1.x): a real column lets `ensureComposeNetworkRow` filter and
     * enforce uniqueness in SQL instead of loading every candidate row and
     * comparing in application code.
     */
    composeKey: text('compose_key'),
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
      table.environmentId.asc().nullsLast().op('uuid_ops')
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
      sql`kind IN ('datacenter', 'docker', 'compose', 'managed', 'reserved')`
    ),
    check(
      'network_single_scope_check',
      sql`(
        (${table.kind} = 'datacenter' AND ${table.datacenterId} IS NOT NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL AND ${table.cidr} IS NOT NULL) OR
        (${table.kind} = 'docker' AND ${table.datacenterId} IS NULL AND ${table.environmentId} IS NULL) OR
        (${table.kind} = 'compose' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL) OR
        (${table.kind} = 'managed' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL AND ${table.cidr} IS NULL) OR
        (${table.kind} = 'reserved' AND ${table.datacenterId} IS NULL AND ${table.serverId} IS NULL AND ${table.environmentId} IS NULL AND ${table.cidr} IS NOT NULL)
      )`
    ),
    /** Unique CIDR per datacenter — a datacenter may own multiple CIDR rows. */
    uniqueIndex('uniq_network_datacenter_cidr')
      .on(table.datacenterId, table.cidr)
      .where(sql`${table.kind} = 'datacenter'`),
    /** At most one platform-allocated managed-engine network per organization. */
    uniqueIndex('uniq_network_organization_managed')
      .on(table.organizationId)
      .where(sql`${table.kind} = 'managed'`),
    /** Compose network idempotency: one row per `(environment_id, compose_key)`. */
    uniqueIndex('uniq_network_environment_compose_key')
      .on(table.environmentId, table.composeKey)
      .where(sql`${table.kind} = 'compose'`),
    check(
      'network_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/** Org-scoped WireGuard mesh — owns its overlay CIDR directly (no `network` row). */
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Host fabric subnet for `tp0` addresses (e.g. `10.250.0.0/16`). */
    cidr: cidr().notNull(),
    name: text(),
  },
  (table) => [
    uniqueIndex('uniq_fabric_organization_id').on(table.organizationId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'fabric_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check(
      'fabric_name_format_check',
      sql`(name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
  ]
)
/**
 * Single source of truth for every managed address. Two non-overlapping private
 * facts: **site CIDR** lives on `network(kind='datacenter', datacenter_id=…)`
 * (a datacenter may own multiple CIDR rows); **a server's private pin into a
 * datacenter** is `ip WHERE server_id AND datacenter_id AND scope = 'datacenter'`
 * (a server may hold multiple pins per datacenter — multi-subnet, dual-stack,
 * multi-NIC — and pins in many datacenters; each pin names its subnet via
 * `network_id`). Free-pool rows keep `datacenter_id` with null `server_id`.
 * Public VPS addresses carry no `network_id`. TurboFabric `tp0` addresses live
 * on `relay.address`, not here. Address family (`version`) is derived from
 * `address` in the API — not stored. Optional `description` is an operator
 * note (`varchar(255)`); IPs are not named.
 */
export const ip = pgTable(
  'ip',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    datacenterId: uuid('datacenter_id'),
    networkId: uuid('network_id'),
    serverId: uuid('server_id'),
    address: inet('address').notNull(),
    allocation: text().notNull(),
    scope: text().notNull(),
    /** Optional operator note — IPs are identified by `address`, not a name. */
    description: text('description'),
    /**
     * Set by the automatic-repin apply pass, cleared by the fan-out sweep
     * once the datacenter routing fan-out for this pin has been enqueued —
     * promoted off `metadata.repin.pendingFanoutAt` (schema-network-keys,
     * Road-to-0.1.x), the same sweep-predicate shape as `delivery.next_
     * attempt_at`. `repin.at` / `repin.from` stay in metadata.
     */
    repinPendingFanoutAt: timestamp('repin_pending_fanout_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_ip_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_network_id').using('btree', table.networkId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_ip_scope_server_datacenter').using(
      'btree',
      table.scope.asc().nullsLast().op('text_ops'),
      table.serverId.asc().nullsLast().op('uuid_ops'),
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_ip_repin_pending_fanout_at')
      .using('btree', table.repinPendingFanoutAt.asc().nullsLast().op('timestamptz_ops'))
      .where(sql`${table.repinPendingFanoutAt} IS NOT NULL`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'ip_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'ip_datacenter_id_datacenter_id_fk',
    }).onDelete('cascade'),
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
    check('ip_allocation_check', sql`allocation IN ('dedicated', 'shared')`),
    check('ip_scope_check', sql`scope IN ('public', 'datacenter')`),
    check(
      'ip_datacenter_scope_check',
      sql`(${table.scope} <> 'datacenter') OR (${table.datacenterId} IS NOT NULL)`
    ),
    /**
     * Free pool: datacenter_id only (no server / network). Membership pin:
     * server_id + datacenter_id (network_id required via
     * `ip_datacenter_member_network_check`).
     */
    check(
      'ip_datacenter_anchor_check',
      sql`(
        ${table.datacenterId} IS NULL OR
        (${table.serverId} IS NULL AND ${table.networkId} IS NULL) OR
        ${table.serverId} IS NOT NULL
      )`
    ),
    /**
     * A membership pin (`scope='datacenter'` + `server_id`) must name its
     * owning subnet. Free-pool rows (`datacenter_id` only) stay unconstrained
     * here.
     */
    check(
      'ip_datacenter_member_network_check',
      sql`(
        ${table.scope} <> 'datacenter' OR
        ${table.serverId} IS NULL OR
        ${table.networkId} IS NOT NULL
      )`
    ),
    uniqueIndex('uniq_ip_org_address').on(table.organizationId, table.address),
  ]
)
/**
 * An address clients use to reach a server, as the operator states it: one
 * `public` entry per server and one per datacenter the server belongs to.
 * Intent only, layered over what the panel already knows (`ip` rows, datacenter
 * pins, daemon-reported interfaces): a blank `address_v4` / `address_v6` means
 * "this server's own address on that side", so repin and existing rows keep
 * working and only router or 1:1 NAT addresses are typed in. Never in `ip`, so
 * one router address may front several servers of an org on different ports.
 * `options.ports` holds the external port per listener (`postgres`, `mysql`,
 * `http`, `https`): absent means the listen port, `null` means not reachable
 * through this address. Read by `src/features/net/client-addresses.ts`.
 */
export const clientAddress = pgTable(
  'address',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `public` | `datacenter` */
    scope: text().notNull(),
    /** Set if and only if `scope = 'datacenter'`. */
    datacenterId: uuid('datacenter_id'),
    /** The DNS name clients type; always contains a dot. */
    hostname: varchar('hostname', { length: 253 }),
    /** Override for the IPv4 address clients use; NULL = this server's own. */
    addressV4: inet('address_v4'),
    /** Override for the IPv6 address clients use; NULL = this server's own. */
    addressV6: inet('address_v6'),
    /** The entry that fills the main connection string (at most one per server). */
    isPrimary: boolean('is_primary').default(false).notNull(),
  },
  (table) => [
    index('idx_address_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_address_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_address_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    uniqueIndex('uniq_address_server_public')
      .on(table.serverId)
      .where(sql`${table.scope} = 'public'`),
    uniqueIndex('uniq_address_server_datacenter')
      .on(table.serverId, table.datacenterId)
      .where(sql`${table.datacenterId} IS NOT NULL`),
    uniqueIndex('uniq_address_server_primary')
      .on(table.serverId)
      .where(sql`${table.isPrimary}`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'address_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'address_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'address_datacenter_id_datacenter_id_fk',
    }).onDelete('cascade'),
    check('address_scope_check', sql`scope IN ('public', 'datacenter')`),
    check(
      'address_datacenter_scope_check',
      sql`(${table.scope} = 'datacenter') = (${table.datacenterId} IS NOT NULL)`
    ),
    check('address_v4_family_check', sql`family(${table.addressV4}) = 4`),
    check('address_v6_family_check', sql`family(${table.addressV6}) = 6`),
  ]
)
/**
 * One server in an org TurboFabric mesh (parallel to managed `node`). Private
 * key never stored; `public_key` stays null until the first successful
 * `server.fabric.reconcile`. `address` is the `tp0` host address; `prefix` is
 * that server's container aggregate, forwarded over `tp0`. Gateway LAN CIDRs
 * persist on `advertised_cidrs` (empty when `role = 'member'`).
 */
export const relay = pgTable(
  'relay',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    fabricId: uuid('fabric_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `tp0` host address (rendered `/32` by `hostRoute32`). */
    address: inet('address').notNull(),
    /**
     * Mesh role — `gateway` advertises `advertised_cidrs` to remote peers;
     * `member` is host-route only (list must stay empty).
     */
    role: text().notNull().default('member'),
    keepalive: integer(),
    /** Operator pin; null = auto-derive from datacenter / public / reported addresses. */
    endpointAddress: inet('endpoint_address'),
    publicKey: text('public_key'),
    /** Container aggregate CIDR forwarded via this relay (e.g. `10.192.0.0/16`). */
    prefix: cidr().notNull(),
    /**
     * Operator-configured LAN CIDRs advertised by gateway relays. Native
     * `cidr[]` (schema-text-types, Road-to-0.1.x): Postgres validates and
     * canonicalizes each element at insert (host bits must be clear —
     * `parseAdvertisedCidrsField` aligns them first), and the column stays
     * open to GIN/containment (`<<`, `>>`) queries if it is ever filtered by
     * network. Was jsonb; not storage-compatible, so this is the one change
     * in this pass that rewrites the table — free while every database is
     * disposable.
     */
    advertisedCidrs: cidr('advertised_cidrs')
      .array()
      .notNull()
      .default(sql`'{}'::cidr[]`),
    /** Sealed `tpsecret` envelope — write-only, same handling as `principal.password`. */
    presharedKey: text('preshared_key'),
  },
  (table) => [
    index('idx_relay_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
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
    unique('relay_fabric_server_unique').on(table.fabricId, table.serverId),
    unique('uniq_relay_fabric_address').on(table.fabricId, table.address),
    unique('uniq_relay_fabric_public_key').on(table.fabricId, table.publicKey),
    check('relay_role_check', sql`role IN ('gateway', 'member')`),
    check(
      'relay_keepalive_check',
      sql`${table.keepalive} IS NULL OR (${table.keepalive} BETWEEN 1 AND 65535)`
    ),
    check(
      'relay_member_advertised_cidrs_empty_check',
      sql`${table.role} <> 'member' OR cardinality(${table.advertisedCidrs}) = 0`
    ),
  ]
)
/**
 * Server-local realization of a `kind='compose'` spanning network (today a
 * Docker bridge subnet carved from that relay's prefix). Implementation may
 * change; the row is the logical network's per-server subnet.
 */
export const subnet = pgTable(
  'subnet',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    networkId: uuid('network_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** Server-local subnet for this network. */
    cidr: cidr().notNull(),
  },
  (table) => [
    index('idx_subnet_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.networkId],
      foreignColumns: [network.id],
      name: 'subnet_network_id_network_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'subnet_server_id_server_id_fk',
    }).onDelete('restrict'),
    unique('subnet_network_server_unique').on(table.networkId, table.serverId),
  ]
)
export const workspace = pgTable(
  'workspace',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: text(),
    description: text('description'),
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
/**
 * SQL for the folder-name CHECKs, built from the shared rule patterns in
 * `contracts/directory-names.ts` so a CHECK cannot drift from the code that
 * validates a typed name. A slug never contains `..` (the pattern allows a
 * single dot inside the name).
 */
const FOLDER_NAME_SQL = FOLDER_NAME_RE.source
const PROJECT_SLUG_SQL = PROJECT_SLUG_RE.source
const ENVIRONMENT_NAME_SQL = ENVIRONMENT_NAME_RE.source
const RESERVED_ENVIRONMENT_NAMES_SQL = RESERVED_SCOPE_NAMES.map((name) => `'${name}'`).join(', ')

export const project = pgTable(
  'project',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    workspaceId: uuid('workspace_id').notNull(),
    /**
     * Denormalized `workspace.organization_id` (schema-project-name-scope,
     * Road-to-0.1.x), resolved at every insert — the same move as
     * `principal.organization_id`, and the same accepted invariant: nothing
     * at the database level keeps it in agreement with the workspace's
     * organization; every write site derives it the same way. It exists so
     * `uniq_project_organization_name` can be a real constraint: project
     * names are unique per organization (trimmed, case-insensitive), and the
     * organization is only reachable through `workspace` otherwise.
     */
    organizationId: uuid('organization_id').notNull(),
    /**
     * The one Git repository this project is. Null for a project that is not
     * repository-backed at all (a template, a managed engine, a hand-written
     * compose of images).
     *
     * **One repository, and it belongs to the project — not to a service.** A
     * repository-backed project *is* its repository: the checkout is what the
     * compose file, the site root, or the app process all come out of, and
     * several repositories in one project would mean several answers to "what
     * is deployed here". Services still carry their own
     * `x-turbopanel.source` block for the per-service half (`branch`,
     * `subdirectory`, `buildCommand`, …) — that is how a monorepo builds two
     * services out of one checkout — but every `sourceId` in the project's
     * compose has to name *this* row. The rule is enforced at the write
     * boundary (`lintComposeYaml`, `projectRepositoryId`), because the compose
     * parser is pure and has no database.
     *
     * A project with no binding yet **adopts** the first repository its compose
     * names, on the same save. That is what lets the create wizard seed a draft
     * and write the project in one act, and it is not a loophole: the adopting
     * save is exactly the one the single-repository rule is checked on.
     *
     * `restrict` rather than `cascade`: deleting the repository out from under
     * a project would leave compose naming an id that no longer resolves.
     * `DELETE /repositories/:id` checks this column alongside the compose
     * references and answers the same 409 `source_referenced_by_compose`
     * before Postgres ever has to raise the FK violation.
     */
    repositoryId: uuid('repository_id').references(
      // `AnyPgColumn` breaks a genuine type cycle — project → repository →
      // environment → project — that TypeScript cannot infer through. Declared
      // inline rather than in `foreignKey()` below for the same reason: the
      // annotation has to sit on the reference itself.
      (): AnyPgColumn => repository.id,
      { onDelete: 'restrict' }
    ),
    name: text(),
    description: text('description'),
    /**
     * System-hierarchy component discriminator (`hosting-ingress`,
     * `managed-ingress`, `managed-ha`, `turbopanel`), promoted out of
     * `metadata.component` (schema-sql-keys, Road-to-0.1.x). NULL for every
     * user project — `kind = 'system'` marks a project as
     * platform-owned. Identity always comes from this column, never from
     * `environment.metadata.component`.
     */
    component: text(),
    /**
     * Short name derived from the project name, unique per organization. It is
     * never part of a path on a host (names and labels only). Changeable until
     * a folder exists under any environment of the project, then locked. A row
     * made without one gets a unique id-shaped slug; create flows send a real one.
     */
    slug: text()
      .default(sql`uuidv7()::text`)
      .notNull(),
    /**
     * Default placement server: environments without their own `server_id`
     * inherit it at deploy / lifecycle / stop time. The API still carries it
     * as `options.defaultServerId`.
     */
    defaultServerId: uuid('default_server_id'),
    /**
     * What the project is (`compose`, `managed`, `system`), promoted out of
     * `metadata.type`. NULL while the project is a draft that has not chosen
     * yet. A template project is `compose` with `metadata.code` set.
     */
    kind: text(),
    /**
     * Optional icon key from the fixed list the project screens offer. NULL
     * means the default; a managed project ignores it.
     */
    icon: text(),
    /** Catalog `code` of the template this project was created from; NULL when not from a template. */
    templateCode: text('template_code'),
    /** Software release line (track) of that template, such as `6.8`. */
    templateTrack: text('template_track'),
    /** Template packaging version (semver) the project was created from. */
    templateVersion: text('template_version'),
    /** Content digest of that template version (`sha256:` and 64 hex digits). */
    templateDigest: text('template_digest'),
  },
  (table) => [
    index('idx_project_default_server_id').using(
      'btree',
      table.defaultServerId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.defaultServerId],
      foreignColumns: [server.id],
      name: 'project_default_server_id_server_id_fk',
    }).onDelete('set null'),
    index('idx_project_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_project_repository_id').using(
      'btree',
      table.repositoryId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'project_workspace_id_workspace_id_fk',
    }).onDelete('restrict'),
    index('idx_project_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'project_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    /**
     * Org-wide display-name uniqueness, trimmed and case-insensitive — the
     * same expression `isProjectDisplayNameTaken` compares with and
     * `uniq_tag_organization_name` already enforces for tags. Partial: a
     * project may have no name. The app check stays as the friendly 409;
     * this is the lock that makes it race-proof.
     */
    uniqueIndex('uniq_project_organization_name')
      .on(table.organizationId, sql`lower(btrim((${table.name})::text))`)
      .where(sql`name IS NOT NULL`),
    /**
     * One project per system component per workspace (system hierarchy).
     * Partial — user projects omit `component`.
     */
    uniqueIndex('uniq_project_workspace_system_component')
      .on(table.workspaceId, table.component)
      .where(sql`component IS NOT NULL`),
    /** Unique per organization. */
    unique('uniq_project_organization_slug').on(table.organizationId, table.slug),
    check('project_slug_check', sql.raw(`slug ~ '${PROJECT_SLUG_SQL}'`)),
    check('project_kind_check', sql`kind IS NULL OR kind IN ('compose', 'managed', 'system')`),
    check(
      'project_template_stamp_check',
      sql`(template_code IS NULL AND template_track IS NULL AND template_version IS NULL AND template_digest IS NULL) OR (template_code IS NOT NULL AND template_track IS NOT NULL AND template_version IS NOT NULL AND template_digest IS NOT NULL)`
    ),
    check(
      'project_template_code_check',
      sql`template_code IS NULL OR template_code ~ '^[a-z][a-z0-9-]{0,63}$'`
    ),
    check(
      'project_template_track_check',
      sql`template_track IS NULL OR template_track ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'`
    ),
    check(
      'project_template_version_check',
      sql`template_version IS NULL OR template_version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'`
    ),
    check(
      'project_template_digest_check',
      sql`template_digest IS NULL OR template_digest ~ '^sha256:[0-9a-f]{64}$'`
    ),
    check(
      'project_icon_check',
      sql`icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image')`
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
      .$onUpdate(() => sql`now()`)
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
    /**
     * The scope folder name on every server (`/srv/users/<owner>/<name>`), so
     * it follows the environment name rule. The default only keeps a row made
     * without a name valid (32 hex characters, never a reserved name); every
     * create flow sends the typed name.
     */
    name: text()
      .default(sql`replace(uuidv7()::text, '-', '')`)
      .notNull(),
    description: text('description'),
    /** The project's primary environment: landing, status, and the source a new environment copies. */
    isPrimary: boolean('is_primary').default(false).notNull(),
    /** Pinned environments are listed right after the primary one. */
    isPinned: boolean('is_pinned').default(false).notNull(),
  },
  (table) => [
    unique('uniq_environment_project_name').on(table.projectId, table.name),
    uniqueIndex('uniq_environment_project_primary')
      .using('btree', table.projectId.asc().nullsLast().op('uuid_ops'))
      .where(sql`${table.isPrimary}`),
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
      'environment_name_check',
      sql.raw(
        `name ~ '${ENVIRONMENT_NAME_SQL}' AND name NOT IN (${RESERVED_ENVIRONMENT_NAMES_SQL})`
      )
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
      .$onUpdate(() => sql`now()`)
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
    name: text(),
    /**
     * Catalog engine code (e.g. `postgres`, `redis`). NOT NULL pre-tag
     * (schema-constraints, Road-to-0.1.x): the one insert path
     * (`client/managed/routes.ts`) always sets it from `ManagedEngineSpec`,
     * a required field at the type level. Several readers still defensively
     * `?? 'postgres'` for the earlier nullable window; harmless now, not
     * removed here since they're not wrong, just no longer load-bearing.
     */
    engine: text().notNull(),
    /** `provisioning` | `applying` | `ready` | `stopped` | `failed` */
    status: text().default('provisioning').notNull(),
    /**
     * This cluster's own copy choice, which wins over the organization default:
     * null follows the default, `none` turns copying off, otherwise the id of a
     * destination. Text, so it has no foreign key: deleting a destination
     * clears it in `features/backups/targets.ts`.
     */
    backupDestination: text('backup_destination'),
  },
  (table) => [
    index('idx_managed_backup_destination').on(table.backupDestination),
    check(
      'managed_backup_destination_check',
      sql`backup_destination IS NULL OR backup_destination = 'none' OR backup_destination ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`
    ),
    index('idx_managed_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_managed_engine').using('btree', table.engine.asc().nullsLast().op('text_ops')),
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
      sql`(${table.name} IS NULL) OR (((char_length((${table.name})::text) >= 1) AND (char_length((${table.name})::text) <= 255)) AND ((${table.name})::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
    ),
    check(
      'managed_engine_check',
      sql`engine IN ('postgres', 'mysql', 'mariadb', 'redis', 'clickhouse')`
    ),
    check(
      'managed_status_check',
      sql`status IN ('provisioning','applying','ready','stopped','failed')`
    ),
  ]
)
/**
 * One server participation (replica) in a managed cluster (`managed`). Exactly
 * one `primary` per `managed_id` (partial unique); replicas use ordinals 2+.
 * Container fan-out uses `ordinal` on `(service_id, role='service', ordinal)`.
 */
export const replica = pgTable(
  'replica',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    managedId: uuid('managed_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `primary` | `replica` */
    role: text().default('primary').notNull(),
    /**
     * Replica class: `failover` (same-datacenter, promotable) or `read`
     * (any org server). Null on primary; ignored when role is primary.
     */
    replicaClass: text('replica_class'),
    /** API JSON still serializes as `readEligible`. */
    isReadEligible: boolean('is_read_eligible').default(false).notNull(),
    /** 1-based member ordinal — mirrors the service-role container ordinal. */
    ordinal: integer().default(1).notNull(),
    /**
     * Resolved private path to the primary (`local` | `datacenter` | `fabric` | `public`).
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
    status: text().default('provisioning').notNull(),
  },
  (table) => [
    index('idx_replica_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'replica_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'replica_server_id_server_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('uniq_replica_primary')
      .on(table.managedId)
      .where(sql`${table.role} = 'primary'`),
    uniqueIndex('uniq_replica_server_private_port')
      .on(table.serverId, table.privatePort)
      .where(sql`${table.privatePort} IS NOT NULL`),
    unique('uniq_replica_managed_ordinal').on(table.managedId, table.ordinal),
    unique('uniq_replica_managed_server').on(table.managedId, table.serverId),
    check('replica_role_check', sql`${table.role} IN ('primary','replica')`),
    check(
      'replica_replica_class_check',
      sql`${table.replicaClass} IS NULL OR ${table.replicaClass} IN ('failover','read')`
    ),
    check('replica_ordinal_positive_check', sql`${table.ordinal} >= 1`),
    check(
      'replica_transport_check',
      sql`${table.replicationTransport} IS NULL OR ${table.replicationTransport} IN ('local','fabric','datacenter','public')`
    ),
    check(
      'replica_status_check',
      sql`status IN ('provisioning','applying','ready','stopped','failed','needs_resync')`
    ),
  ]
)
/**
 * A completed managed-engine backup artifact, promoted out of
 * `managed.options.backups[]` (schema-child-tables, Road-to-0.1.x). The
 * 200-entry jsonb array was rewritten-and-truncated whole on every
 * insert/delete with no row lock or partial jsonb write, racing every other
 * `managed.options` mutator (settings PATCH, database create/delete) on the
 * same column — a concurrent write could silently revert a just-recorded
 * backup. No `organization_id`: resolved per-request the same way every
 * other `managed` child row does (`managed → environment → project →
 * workspace → organization`), matching `replica`, not denormalized.
 *
 * `id` deliberately breaks the uuid-PK house style: it stays the daemon's
 * `bk_<hex>` token (`generateBackupId` in `client/managed/backups.ts`)
 * because that exact string becomes the backup artifact's filename on the
 * host — swapping to a fresh uuid PK would decouple the row's identity from
 * the file it names.
 */
export const backup = pgTable(
  'backup',
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
    managedId: uuid('managed_id').notNull(),
    /**
     * The daemon's own `bk_<hex>` id — minted from random bytes on the host
     * and also the on-disk filename. Unique **per managed engine**, not
     * globally: the daemon that reports it belongs to one organization, and
     * a global key would let one host's report shadow another organization's
     * record of the same string (a hostile daemon, or a plain collision).
     */
    backupId: text('backup_id').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** SHA-256 hex digest of the artifact. */
    checksum: text().notNull(),
    /** Null for an instance-scope backup; set for a single-database backup. */
    database: text(),
    /** The `database` row the dump was of; NULL for an instance-scope backup or once that database is dropped (the name stays in `database`). */
    databaseId: uuid('database_id'),
    /** Artifact path relative to the backup root of the host. */
    path: text().notNull(),
    /**
     * The {@link retention} whose scheduled run made this artifact; null for
     * a manual backup. `set null` so deleting a policy keeps the record of an
     * artifact that is still on disk.
     */
    retentionId: uuid('retention_id'),
    /**
     * Host that holds the on-disk artifact (the primary when the backup ran).
     * Null on rows written before this column existed, or after that server
     * is deleted (`set null`). Restore/delete must not assume the current
     * primary still has the file.
     */
    serverId: uuid('server_id'),
  },
  (table) => [
    index('idx_backup_managed_id_created_at').using(
      'btree',
      table.managedId.asc(),
      table.createdAt.desc()
    ),
    index('idx_backup_retention_id').using('btree', table.retentionId.asc().nullsLast()),
    index('idx_backup_server_id').using('btree', table.serverId.asc().nullsLast()),
    index('idx_backup_database_id').using('btree', table.databaseId.asc().nullsLast()),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'backup_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.retentionId],
      foreignColumns: [retention.id],
      name: 'backup_retention_id_retention_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'backup_server_id_server_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.databaseId],
      foreignColumns: [managedDatabase.id],
      name: 'backup_database_id_database_id_fk',
    }).onDelete('set null'),
    uniqueIndex('uniq_backup_managed_backup_id').on(table.managedId, table.backupId),
    check('backup_id_format_check', sql`backup_id ~ '^[A-Za-z0-9_-]+$'`),
    check('backup_checksum_format_check', sql`checksum ~ '^[a-f0-9]{64}$'`),
    check('backup_size_bytes_check', sql`size_bytes >= 0`),
  ]
)
/**
 * A named S3-compatible destination an organization copies finished backups
 * to (`features/backups/targets.ts`). The secret access key is stored sealed
 * (`tpsecret` envelope) and never returned by any API; `access_key_id` is an
 * identifier, not a secret. Deleting an organization removes its targets;
 * a target still named by an assignment cannot be deleted (RESTRICT).
 */
export const backupTarget = pgTable(
  'destination',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: text().notNull(),
    kind: text().default('s3').notNull(),
    endpoint: text().notNull(),
    region: text().notNull(),
    bucket: text().notNull(),
    /** Folder inside the bucket; no leading or trailing slash; empty for none. */
    prefix: text().default('').notNull(),
    isPathStyle: boolean('is_path_style').default(true).notNull(),
    isServerSideEncrypted: boolean('is_server_side_encrypted').default(false).notNull(),
    accessKeyId: text('access_key_id').notNull(),
    /** `tpsecret` envelope of the secret access key. Never returned by an API. */
    secretKeySealed: text('secret_key_sealed').notNull(),
    lastTestedAt: timestamp('last_tested_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Null until the first test; then whether it passed. */
    isLastTestOk: boolean('is_last_test_ok'),
    /** A plain reason when the last test failed. */
    lastTestError: text('last_test_error'),
    createdBy: uuid('created_by'),
  },
  (table) => [
    uniqueIndex('uniq_destination_organization_name').on(table.organizationId, table.name),
    index('idx_destination_created_by').on(table.createdBy),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'destination_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'destination_created_by_user_id_fk',
    }).onDelete('set null'),
    // Mirror BACKUP_TARGET_STORE_KINDS (src/features/backups/vocabulary.ts) — pinned by enum-checks.test.ts.
    check('destination_kind_check', sql`kind IN ('s3')`),
    check('destination_name_check', sql`char_length(name) BETWEEN 1 AND 64`),
  ]
)
/**
 * How copying one backup to one target stands, as the host reported it
 * (`features/backups/copy-report.ts`). Keyed by the engine and the daemon's
 * `bk_` id as text, not by the {@link backup} row, so a report that arrives
 * before the backup's own run report still lands. `destination_name` is kept so a
 * deleted target still reads in plain words.
 */
export const backupCopy = pgTable(
  'shipment',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    managedId: uuid('managed_id').notNull(),
    backupId: text('backup_id').notNull(),
    destinationId: uuid('destination_id'),
    destinationName: text('destination_name').notNull(),
    state: text().default('pending').notNull(),
    /** A plain reason when `state` is `failed`. */
    error: text(),
    /** Object key in the bucket (prefix included), once copied. */
    objectKey: text('object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    attempts: integer().default(0).notNull(),
    copiedAt: timestamp('copied_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** The host that reported the last state. */
    serverId: uuid('server_id'),
  },
  (table) => [
    uniqueIndex('uniq_shipment_managed_destination').on(
      table.managedId,
      table.backupId,
      table.destinationId
    ),
    index('idx_shipment_managed_id_backup_id').on(table.managedId, table.backupId),
    index('idx_shipment_destination_id').on(table.destinationId),
    index('idx_shipment_server_id').on(table.serverId),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'shipment_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.destinationId],
      foreignColumns: [backupTarget.id],
      name: 'shipment_destination_id_destination_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'shipment_server_id_server_id_fk',
    }).onDelete('set null'),
    check('shipment_backup_id_format_check', sql`backup_id ~ '^[A-Za-z0-9_-]+$'`),
    // Mirror BACKUP_COPY_STATES (src/features/backups/vocabulary.ts) — pinned by enum-checks.test.ts.
    check(
      'shipment_state_check',
      sql`state IN ('pending', 'copying', 'copied', 'failed', 'removed')`
    ),
    check('shipment_attempts_check', sql`attempts >= 0`),
  ]
)
/**
 * Tracking row for Organization-CA-signed managed leaves (ProxySQL frontend
 * and per-replica engine). Re-issuance upserts rather than appending history
 * (partial uniques below). Declared after `replica` / `managed` / `server` so
 * those FKs resolve.
 */
export const leaf = pgTable(
  'leaf',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `ingress` | `engine` */
    kind: text().notNull(),
    /** Engine leaves only — the managed cluster that owns the replica. */
    managedId: uuid('managed_id'),
    /** Engine leaves only — the cluster replica whose leaf this tracks. */
    replicaId: uuid('replica_id'),
    /** Signing Organization CA row (`tls.id`). */
    caId: uuid('ca_id').notNull(),
    caGeneration: integer('ca_generation').notNull(),
    notAfter: timestamp('not_after', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    issuedAt: timestamp('issued_at', {
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** `active` | `stale` */
    state: text().default('active').notNull(),
    staleAt: timestamp('stale_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    staleReason: text('stale_reason'),
    /** `offline` | `unused` | `owner` */
    staleCause: text('stale_cause'),
    attempts: integer().default(0).notNull(),
    attemptedAt: timestamp('attempted_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
  },
  (table) => [
    index('idx_leaf_not_after').using(
      'btree',
      table.notAfter.asc().nullsLast().op('timestamptz_ops')
    ),
    index('idx_leaf_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    // FK columns the renewal sweep and the per-server/per-engine lookups
    // filter on; the two partial uniques below cover only one kind each.
    index('idx_leaf_ca_id').using('btree', table.caId.asc().nullsLast().op('uuid_ops')),
    index('idx_leaf_managed_id').using('btree', table.managedId.asc().nullsLast().op('uuid_ops')),
    index('idx_leaf_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('uniq_leaf_ingress_server')
      .on(table.serverId)
      .where(sql`${table.kind} = 'ingress'`),
    uniqueIndex('uniq_leaf_engine_replica')
      .on(table.replicaId)
      .where(sql`${table.kind} = 'engine'`),
    /** Plain, because a partial unique index cannot serve the cascade lookup from `replica`. */
    index('idx_leaf_replica_id').on(table.replicaId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'leaf_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'leaf_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'leaf_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.replicaId],
      foreignColumns: [replica.id],
      name: 'leaf_replica_id_replica_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.caId],
      foreignColumns: [tls.id],
      name: 'leaf_ca_id_tls_id_fk',
    }).onDelete('cascade'),
    check('leaf_kind_check', sql`${table.kind} IN ('ingress','engine')`),
    check('leaf_state_check', sql`state IN ('active','stale')`),
    check(
      'leaf_stale_cause_check',
      sql`stale_cause IS NULL OR stale_cause IN ('offline','unused','owner')`
    ),
    check(
      'leaf_stale_check',
      sql`(${table.state} = 'stale') = (${table.staleAt} IS NOT NULL) AND (${table.state} = 'stale') = (${table.staleCause} IS NOT NULL)`
    ),
    check('leaf_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'leaf_text_length_check',
      sql`(${table.staleReason} IS NULL OR length(${table.staleReason}) <= 300) AND (${table.lastError} IS NULL OR length(${table.lastError}) <= 300)`
    ),
    check(
      'leaf_kind_keys_check',
      sql`(
        (${table.kind} = 'ingress' AND ${table.replicaId} IS NULL AND ${table.managedId} IS NULL)
        OR
        (${table.kind} = 'engine' AND ${table.replicaId} IS NOT NULL AND ${table.managedId} IS NOT NULL)
      )`
    ),
  ]
)
/**
 * Per-server ProxySQL backend monitor credential (control-plane minted).
 *
 * A **secret-bearing table**, deliberately separate from `server.options`:
 * `options` is operator-facing configuration that `GET /servers`,
 * `GET /servers/:id`, and the developer routes return verbatim, and that the
 * approved cached read models copy into Redis. A sealed password must never
 * ride along on any of those paths, so it lives here where nothing
 * client-facing selects it.
 *
 * One row per server (`uniq_monitor_server`): ProxySQL's monitor credential is
 * a single global per instance and one ProxySQL runs per host. Cascades with
 * the server so a deleted host leaves no orphaned secret behind.
 */
export const monitor = pgTable(
  'monitor',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    /** Deterministic `tp_monitor_<serverId prefix>`; engine identifier limits apply. */
    username: varchar({ length: 64 }).notNull(),
    /**
     * Data-encryption sealed password (`ENVELOPE_PREFIX_SECRET`). Resealed to a
     * `tpdaemon` envelope per recipient at send time — never shipped as stored.
     */
    secretEnvelope: text('secret_envelope').notNull(),
  },
  (table) => [
    uniqueIndex('uniq_monitor_server').on(table.serverId),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'monitor_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)

/**
 * Highest RAM and CPU readings of one server per hour. The over-tier rules judge
 * a server on the highest reading of the last 7 days, so ballooning memory or a
 * hot-added core never flips the verdict on one low sample. One row per
 * (server, hour); an upsert only ever raises the stored figures. Rows older
 * than the grace window are pruned by the 15-minute cron
 * (`features/servers/peak.ts`).
 */
export const peak = pgTable(
  'peak',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    /** Start of the UTC hour these readings cover (aligned by the writer). */
    bucket: timestamp('bucket', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    /** Highest total RAM in bytes read in the hour; NULL when none was read. */
    memoryBytes: bigint('memory_bytes', { mode: 'number' }),
    /** Highest physical core count read in the hour; NULL when none was read. */
    cores: integer('cores'),
  },
  (table) => [
    uniqueIndex('uniq_peak_server_bucket').on(table.serverId, table.bucket),
    index('idx_peak_bucket').on(table.bucket),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'peak_server_id_server_id_fk',
    }).onDelete('cascade'),
    check('peak_memory_bytes_check', sql`memory_bytes >= 0`),
    check('peak_cores_check', sql`cores >= 0`),
    check('peak_reading_check', sql`memory_bytes IS NOT NULL OR cores IS NOT NULL`),
  ]
)

/**
 * Durable HA journal for one managed cluster. At most one in-flight recovery
 * per `managed_id` (partial unique on non-terminal states). Member ids are
 * stored without a node FK so deleting a member cannot block the journal.
 */
export const recovery = pgTable(
  'recovery',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    managedId: uuid('managed_id').notNull(),
    /** `automatic-failover` | `switchover` | `disaster-recovery` */
    kind: text().notNull(),
    /**
     * The member that was primary when the run started. A plain id with no
     * foreign key on purpose: the journal outlives the member (a former
     * primary is removed after a switchover).
     */
    sourcePrimaryMemberId: uuid('source_primary_member_id').notNull(),
    /** The member promoted by the run; set null if that member is later removed. */
    targetMemberId: uuid('target_member_id'),
    /**
     * `detecting` | `fencing` | `promoting` | `repointing` |
     * `reconciling-ingress` | `verifying` | `completed` | `failed` | `blocked`
     */
    state: text().notNull(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_recovery_managed_id').using(
      'btree',
      table.managedId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'recovery_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_recovery_inflight_managed')
      .on(table.managedId)
      .where(sql`${table.state} NOT IN ('completed','failed','blocked')`),
    check(
      'recovery_kind_check',
      sql`${table.kind} IN ('automatic-failover','switchover','disaster-recovery')`
    ),
    check(
      'recovery_state_check',
      sql`${table.state} IN ('detecting','fencing','promoting','repointing','reconciling-ingress','verifying','completed','failed','blocked')`
    ),
    foreignKey({
      columns: [table.targetMemberId],
      foreignColumns: [replica.id],
      name: 'recovery_target_member_id_replica_id_fk',
    }).onDelete('set null'),
  ]
)
export const variable = pgTable(
  'variable',
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
      .$onUpdate(() => sql`now()`)
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
    /** API JSON still serializes as `forBuild`. */
    isForBuild: boolean('is_for_build').default(false).notNull(),
    /** API JSON still serializes as `forRuntime`. */
    isForRuntime: boolean('is_for_runtime').default(true).notNull(),
    description: text('description'),
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
      table.bindingId.asc().nullsLast().op('uuid_ops')
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    environmentId: uuid('environment_id').notNull(),
    /**
     * User-facing label (Postgres column `name`, renamed from `display_name`).
     * Nullable and not unique. Client JSON field is `name`.
     */
    /** Stays `varchar(255)` (schema-text-types audit, 2026-09-16): `reconcile-services.ts` writes the compose service key straight from the document with no length check — the column is that write's only guard. */
    name: varchar({ length: 255 }),
    description: text('description'),
    /**
     * Compose service key — derived from the compose document (project base +
     * environment overlay). Written only by reconcile (`reconcileServicesFromCompose`),
     * managed container allocation, and daemon-report container reconcile
     * (`ensureServicesForReportedContainers`) — never by a client request.
     * Unique per environment (`uniq_service_environment_compose_name`);
     * `name` itself is not unique and must not be assumed so.
     */
    composeServiceName: varchar('compose_service_name', { length: 255 }).notNull(),
    /**
     * Folder name under the site owner's tree (`services/<slug>`). Chosen at
     * creation (a slug, or the service id in uuid mode) and locked once a
     * `folder` row exists for the service. NULL until set.
     */
    slug: text(),
    /**
     * True when the folder lives in the `common` scope instead of the
     * environment's own. Chosen at creation, never changed.
     */
    isCommon: boolean('is_common').default(false).notNull(),
  },
  (table) => [
    /** Unique per environment. */
    uniqueIndex('uniq_service_environment_compose_name').on(
      table.environmentId,
      table.composeServiceName
    ),
    /** One folder name per environment; partial while slugs are being filled in. */
    uniqueIndex('uniq_service_environment_slug')
      .on(table.environmentId, table.slug)
      .where(sql`slug IS NOT NULL`),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'service_environment_id_environment_id_fk',
    }).onDelete('restrict'),
    check(
      'service_slug_check',
      sql.raw(String.raw`slug IS NULL OR (slug ~ '${FOLDER_NAME_SQL}' AND slug !~ '\.\.')`)
    ),
  ]
)
/**
 * One row per participating `(environment, server)` in a deploy. Unique on
 * that pair; `server_id` RESTRICT mirrors `container.server_id`.
 *
 * This is **current desired/applied state**, upserted on every redeploy — not
 * a history table. `finished_at` / `duration_ms` / `outcome` summarize only the
 * **last** apply attempt. Per-attempt history lives in the append-only
 * `command` table (`name = 'environment.deploy'`, scoped by
 * `context->>'environmentId'`).
 */
export const deployment = pgTable(
  'deployment',
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
      .$onUpdate(() => sql`now()`)
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
    /**
     * Back-reference to the `command` row for the most recent apply attempt on
     * this `(environment, server)`; set null when that command is pruned. This
     * is the join key from current state into the append-only command history.
     */
    lastCommandId: uuid('last_command_id'),
    /** When the last apply attempt reached a terminal state. */
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** Wall-clock duration of the last apply attempt, in milliseconds. */
    durationMs: integer('duration_ms'),
    /** Terminal outcome of the last apply attempt; NULL until one finishes. */
    outcome: text(),
  },
  (table) => [
    unique('uniq_deployment_environment_server').on(table.environmentId, table.serverId),
    index('idx_deployment_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_deployment_last_command')
      .on(table.lastCommandId)
      .where(sql`${table.lastCommandId} IS NOT NULL`),
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
      sql`${table.status} IN ('pending','applying','applied','failed','draining')`
    ),
    check(
      'deployment_generation_check',
      sql`${table.desiredGeneration} >= 0 AND (${table.appliedGeneration} IS NULL OR ${table.appliedGeneration} >= 0)`
    ),
    check(
      'deployment_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('applied','failed','timed_out')`
    ),
    foreignKey({
      columns: [table.lastCommandId],
      foreignColumns: [command.id],
      name: 'deployment_last_command_id_command_id_fk',
    }).onDelete('set null'),
  ]
)
/**
 * One scheduled instance of a logical service. Never mint a `service` row per
 * replica — `slot` is 0-based (unlike `container.ordinal` / `replica.ordinal`,
 * which are 1-based). A slot is derived scheduling state: `service_id`
 * CASCADE so deleting a service drops its slots rather than blocking.
 */
export const slot = pgTable(
  'slot',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    environmentId: uuid('environment_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /**
     * Cross-host address on a spanning compose network. One per slot — a
     * service typically joins one spanning network per environment.
     */
    address: inet('address'),
    /** 0-based replica slot (not 1-based like `container.ordinal`). */
    slot: integer().notNull(),
    generation: integer().default(0).notNull(),
    desiredState: text('desired_state').default('running').notNull(),
  },
  (table) => [
    unique('uniq_slot_service_slot').on(table.serviceId, table.slot),
    index('idx_slot_environment_generation').using(
      'btree',
      table.environmentId.asc(),
      table.generation.asc()
    ),
    index('idx_slot_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'slot_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'slot_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'slot_server_id_server_id_fk',
    }).onDelete('restrict'),
    check('slot_slot_nonnegative_check', sql`${table.slot} >= 0`),
    check(
      'slot_desired_state_check',
      sql`${table.desiredState} IN ('running','stopped','removed')`
    ),
  ]
)
/**
 * Cron-style scheduled command on a service. No execution columns (no
 * `last_run_at` / result) and no run-history table this phase.
 */
export const task = pgTable(
  'task',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    name: text().notNull(),
    /** Cron expression. */
    schedule: text().notNull(),
    command: text().notNull(),
    timezone: text(),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    /** `allow` | `forbid` | `replace` */
    concurrencyPolicy: text('concurrency_policy').default('forbid').notNull(),
    timeoutSeconds: integer('timeout_seconds'),
  },
  (table) => [
    unique('uniq_task_service_name').on(table.serviceId, table.name),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'task_service_id_service_id_fk',
    }).onDelete('cascade'),
    check(
      'task_concurrency_policy_check',
      sql`${table.concurrencyPolicy} IN ('allow','forbid','replace')`
    ),
  ]
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    key: text().notNull(),
    value: text().default('').notNull(),
  },
  (table) => [
    unique('uniq_label_server_key').on(table.serverId, table.key),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'label_server_id_server_id_fk',
    }).onDelete('cascade'),
    check(
      'label_key_format_check',
      sql`(char_length((${table.key})::text) >= 1) AND (char_length((${table.key})::text) <= 255) AND ((${table.key})::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text)`
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    serviceId: uuid('service_id').notNull(),
    /** Optional pin into the org TLS library; null = Caddy tls internal (self-signed). */
    tlsId: uuid('tls_id'),
    /** Optional pin to a managed `ip` row for ingress addressing. */
    ipId: uuid('ip_id'),
    name: text(),
    description: text('description'),
    /**
     * Mirrors validated `options.protocol` (schema-sql-keys, Road-to-0.1.x):
     * `system/reconcile.ts` filters ingress-container decisions on this value
     * in raw SQL three times. `options.protocol` stays the parsed/validated
     * source of truth for app-code readers (`resolveHostingProtocol`); this
     * column exists so SQL can filter/constrain it without a jsonb cast.
     * NULL reads as `'http'`, same default `resolveHostingProtocol` applies.
     */
    protocol: text(),
    /**
     * When a waiting Let's Encrypt request was made (the DNS did not point at
     * the server yet); NULL when none is waiting. The sweep retries every row
     * with a value, so it is a column with a partial index, not a JSON key.
     */
    pendingAt: timestamp('pending_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_hosting_pending')
      .on(table.updatedAt)
      .where(sql`${table.pendingAt} IS NOT NULL`),
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
    check('hosting_protocol_check', sql`protocol IS NULL OR protocol IN ('http', 'tcp', 'udp')`),
  ]
)
/**
 * Uniqueness-enforcement mirror of `hosting.options.hostnames[]`
 * (schema-child-tables, Road-to-0.1.x) — NOT a promotion. `hosting.options`
 * stays the read source of truth for the deploy pipeline and the panel API;
 * this table exists solely so Postgres can enforce
 * `UNIQUE (routing_organization_id, hostname)`, an invariant a jsonb array
 * element cannot express across rows. Every write to `options.hostnames`
 * (panel `POST`/`PATCH /hostings` and compose's `reconcileHostingsFromCompose`)
 * does a full delete-then-insert replace of this hosting's rows in the same
 * transaction as the `hosting` write, mirroring `hostnames[]`'s own
 * replace-whole-array semantics — see `replaceHostingHostnames` in
 * `features/servers/hostname-records.ts`.
 *
 * `routing_organization_id` is named for the future cross-org-hosting feature
 * (hosting onto another organization's servers), where it would diverge from
 * the *creating* organization; today the two are always identical, resolved
 * by whichever write path holds it — the acting organization at the panel
 * routes, `reconcileHostingsFromCompose`'s deploy-scoped organization at
 * compose — via the same `service → environment → project → workspace →
 * organization` ancestry `resolveEntityOrganizationId`'s `'hosting'` case
 * walks. No `path_prefix` in the unique key: two hostings in one organization
 * can never share a hostname even on different paths. No `path_prefix` column
 * at all — `pathPrefix` is one value per `hosting` row (a sibling field on
 * `options`), not per hostname.
 */
export const hostname = pgTable(
  'hostname',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    hostingId: uuid('hosting_id').notNull(),
    routingOrganizationId: uuid('routing_organization_id').notNull(),
    hostname: text().notNull(),
  },
  (table) => [
    index('idx_hostname_hosting_id').using(
      'btree',
      table.hostingId.asc().nullsLast().op('uuid_ops')
    ),
    unique('uniq_hostname_routing_organization_id_hostname').on(
      table.routingOrganizationId,
      table.hostname
    ),
    foreignKey({
      columns: [table.hostingId],
      foreignColumns: [hosting.id],
      name: 'hostname_hosting_id_hosting_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.routingOrganizationId],
      foreignColumns: [organization.id],
      name: 'hostname_routing_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
export const container = pgTable(
  'container',
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
      .$onUpdate(() => sql`now()`)
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
    /**
     * `pending` until the daemon reports, then Docker Engine's container
     * state verbatim (`created` … `dead`), or `unknown` when the daemon
     * reports a state this list does not know — see `CONTAINER_STATUSES`
     * in src/features/environments/container-records.ts; pinned by enum-checks.test.ts.
     */
    status: text('status').default('pending').notNull(),
    /**
     * `role='ingress'` rows always use `ordinal = 1` and are named
     * `<service.id>-in` via `ingressContainerNameFromService` — both the
     * per-service Traefik frontend and the shared per-server ProxySQL
     * managed-ingress frontend. `role='turbopanel'` is the platform
     * `turbopanel-system` compose stack (`database` / `queue`)
     * plus Orchestrator (`-ha`). `role='service'` is the ordinary
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
    index('idx_container_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_container_status').using('btree', table.status.asc().nullsLast().op('text_ops')),
    uniqueIndex('uniq_container_server_container_id')
      .on(table.serverId, table.containerId)
      .where(sql`container_id IS NOT NULL`),
    uniqueIndex('uniq_container_service_role_ordinal').on(
      table.serviceId,
      table.role,
      table.ordinal
    ),
    check('container_ordinal_positive_check', sql`ordinal >= 1`),
    check('container_role_check', sql`role IN ('service', 'ingress', 'turbopanel')`),
    check(
      'container_status_check',
      sql`status IN ('pending', 'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown')`
    ),
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
 * A principal is a site owner's Linux user: the host account that runs sites
 * and owns their tree. `organization_id` is the owning org (set on every
 * insert, see the column note). Names are one pool per organization:
 * `uniq_principal_organization_*` keep the typed `username` and the applied
 * login unique per org, case-insensitively. Database logins are not
 * principals; they live in `login`.
 */
export const principal = pgTable(
  'principal',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /**
     * Holds `home` (`/srv/users/<username>`) plus a mirror of an optional
     * operator `uid`/`gid` override when set — never an instance-allocated id.
     */
    metadata: jsonb(),
    options: jsonb(),
    /**
     * How the account may reach its own host account over SSH: `none` (no
     * login, keys stay on file), `sftp` (file transfer only) or `shell`
     * (interactive shell plus transfer). The daemon still receives the shell
     * this level encodes, so the wire is unchanged. Effective access also needs
     * a key or password; see `features/principals/principal-access.ts`.
     */
    access: text().default('sftp').notNull(),

    /**
     * Account name. Allowlist mirrors POSIX/database account naming: starts
     * with a letter or underscore, then letters/digits/underscore/hyphen
     * (`^[A-Za-z_][A-Za-z0-9_-]*$`), 1–255 chars. Server principals additionally
     * enforce `MAX_PRINCIPAL_USERNAME_LENGTH` (28) at the API layer (Linux
     * login limit).
     */
    username: varchar({ length: 255 }).notNull(),
    /**
     * Login actually applied on the target system (Linux account / engine
     * role). Equal to `username`, or `username` plus a random `_<11 chars>`
     * suffix when the owning organization's randomized-usernames default is
     * on (or the principal is a managed root, which is always suffixed).
     * Decided once at create — toggling the org default never renames
     * existing principals. `username` stays the short internal identity.
     */
    appliedUsername: varchar('applied_username', { length: 255 }).notNull(),
    /**
     * Write-only credential. Stored as a `tpsecret.v<version>.…` envelope (instance
     * at-rest seal). Never returned on GET; delivery re-seals to `tpdaemon`
     * for the target daemon.
     */
    password: text(),
    /**
     * Owning organization. Set on every insert regardless of scope path —
     * `projectId` and `managedId` are both optional and a tenancy-only
     * principal (`store.ts` `createPrincipal`) has neither, so this is the
     * one column every authz ancestry lookup can rely on. For a managed-engine
     * principal this is the managed row's *home* org (resolved through
     * `managed.environment_id → environment → project → workspace`), not the
     * possibly-plural set of orgs whose servers currently host the cluster's
     * replicas (`resolveManagedOwningOrganizationIds` — a distinct, genuinely
     * multi-valued concept used for username-collision checks only).
     */
    organizationId: uuid('organization_id').notNull(),
    /**
     * Optional project scope for hosting principals. SET NULL on project
     * delete. A principal the deleted project owned and nothing else uses is
     * marked with `removal_requested_at` and removed (row, Linux user and
     * home) once its folders are gone; one still in use outlives the project.
     */
    projectId: uuid('project_id'),
    /**
     * When the delete of the project that owned this principal asked for it
     * to go. Set only on a principal nothing else used at that moment; the
     * removal sweep deletes the row and retires the host account once no
     * folder row names it and every server it is on is connected. NULL for
     * every other principal.
     */
    removalRequestedAt: timestamp('removal_requested_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_principal_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_principal_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'principal_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'principal_project_id_project_id_fk',
    }).onDelete('set null'),
    check('principal_access_check', sql`access IN ('none', 'sftp', 'shell')`),
    check(
      'principal_username_format_check',
      sql`(char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    check(
      'principal_applied_username_format_check',
      sql`(char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
    // One name pool per organization. No global unique: the same name
    // legitimately recurs across organizations. The app check
    // (`isServerPrincipalUsernameTaken`) answers 409 first; these indexes are
    // the backstop.
    uniqueIndex('uniq_principal_organization_username').on(
      table.organizationId,
      sql`lower(${table.username})`
    ),
    uniqueIndex('uniq_principal_organization_applied_username').on(
      table.organizationId,
      sql`lower(${table.appliedUsername})`
    ),
  ]
)
/**
 * A public key that may authenticate as this principal over SSH.
 *
 * A table rather than `principal.options` jsonb: `parsePrincipalOptions` is
 * drop-on-invalid, which is the wrong posture for a credential, and one more
 * reason is specific to keys: **"which principals does this fingerprint reach?" has to be
 * answerable in one query.** When a laptop is lost the operator has a
 * fingerprint and needs every account it opens, across every project and every
 * server. A blob per principal cannot answer that.
 *
 * `publicKey` holds the **re-rendered** `<type> <base64>` from
 * `parseSshPublicKey`, never the pasted line: an `authorized_keys` entry may
 * legally carry a leading options field (`command="…",no-pty`), and neither
 * honouring nor silently stripping one is acceptable. The comment is split into
 * its own column so the stored key has exactly two fields and cannot grow a
 * third.
 *
 * `fingerprint` is `SHA256:<base64 unpadded>` over the decoded blob — byte
 * identical to `ssh-keygen -lf`, so an operator can compare what the panel
 * shows against what their agent shows.
 *
 * `userId` is **provenance, not ownership**: which org member added the key, so
 * "revoke everything Alice can reach" is one query without inventing a
 * user↔principal join table. Ownership stays with the principal, because
 * `authorized_keys` is a per-account file and the daemon has to render it
 * without resolving org membership. `set null` on user delete — losing who
 * added a key must never silently delete the key.
 *
 * No `organization_id`: derived through `principal`, matching that table.
 */
export const sshKey = pgTable(
  'ssh',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    /** Operator-facing label. Not the key comment — that is `comment`. */
    name: text().notNull(),
    keyType: text('key_type').notNull(),
    /** Canonical `<type> <base64>`, re-rendered from the decoded blob. */
    publicKey: text('public_key').notNull(),
    /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
    fingerprint: text().notNull(),
    /** Sanitized display comment from the pasted line, when it had one. */
    comment: text(),
    /** Org member who added it — audit provenance, not ownership. */
    userId: uuid('user_id'),
    /** RSA modulus size; null for the fixed-size key types. */
    bits: integer(),
  },
  (table) => [
    // The lost-laptop query: every account one fingerprint opens.
    index('idx_ssh_fingerprint').using('btree', table.fingerprint.asc().nullsLast().op('text_ops')),
    index('idx_ssh_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'ssh_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ssh_user_id_user_id_fk',
    }).onDelete('set null'),
    // Keyed on the fingerprint rather than the key text: the fingerprint is
    // over the decoded bytes, so two spellings of one key collide here as they
    // should.
    unique('ssh_fingerprint_unique').on(table.principalId, table.fingerprint),
    check(
      'ssh_type_check',
      sql`${table.keyType} IN ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')`
    ),
    check('ssh_fingerprint_check', sql`${table.fingerprint} ~ '^SHA256:[A-Za-z0-9+/]{43}$'`),
    // A newline in the stored key would be a second authorized_keys entry. The
    // application parser already refuses one; this is the backstop that makes a
    // bug there unable to reach the file.
    check(
      'ssh_public_key_check',
      sql`${table.publicKey} ~ '^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$'`
    ),
    check('ssh_name_check', sql`char_length(${table.name}) >= 1`),
  ]
)

/**
 * One principal on one server: where a `system` principal exists (or is about
 * to exist) as a Linux account. `principal` stays the single org-scoped
 * identity row; this is its per-server form. `state` follows the host:
 * `pending` once a deploy that materializes the account is queued, `present`
 * when that deploy succeeded, `retiring` once a stop carrying
 * `retirePrincipals` is queued, `absent` when it succeeded. `uid` / `gid`
 * are what the host actually assigned and stay NULL until the daemon reports
 * them; the partial unique on `(server_id, uid)` is what makes a reported id
 * trustworthy. `source` says why the account is there: a compose
 * `x-turbopanel.principals` alias, a manually created project principal, or a
 * storage entry owned by the principal. Rows are bookkeeping beside the
 * implicit reach (project → environment.server_id) until that reach is
 * retired; deploy, teardown and server removal write them.
 */
export const principalPlacement = pgTable(
  'placement',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    serverId: uuid('server_id').notNull(),
    /** `pending` | `present` | `retiring` | `absent` */
    state: text().notNull(),
    /** Host-assigned ids, reported by the daemon; NULL until then. */
    uid: integer(),
    gid: integer(),
    /** Account home on the host (`/srv/users/<applied_username>`). */
    home: text().notNull(),
    /** `compose` | `manual` | `storage` */
    source: text().notNull(),
  },
  (table) => [
    index('idx_placement_server_id').using(
      'btree',
      table.serverId.asc().nullsLast().op('uuid_ops')
    ),
    unique('uniq_placement_principal_server').on(table.principalId, table.serverId),
    uniqueIndex('uniq_placement_server_uid')
      .on(table.serverId, table.uid)
      .where(sql`${table.uid} IS NOT NULL`),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'placement_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'placement_server_id_server_id_fk',
    }).onDelete('cascade'),
    check('placement_state_check', sql`state IN ('pending', 'present', 'retiring', 'absent')`),
    check('placement_source_check', sql`source IN ('compose', 'manual', 'storage')`),
  ]
)

/**
 * One row per service or volume folder on one server: the single record of
 * "something exists under this scope on that server". The folder name is the
 * asset's `slug` at the moment the folder was planned, and `scope` is the
 * environment name (or `common`) exactly as it is on disk. While a row exists
 * (any state but `missing`) the environment's name, the asset's slug, the
 * project slug and the organization's folder-name setting cannot change.
 *
 * `planned` (reserved, not yet on the host), `present`, `removing` (asset
 * deleted, the host has not confirmed, for example an offline server),
 * `orphan` (found on the host with no asset behind it), `missing` (recorded
 * but gone from the host). `service_id` and `storage_id` become NULL when the
 * asset row is deleted first; the row stays (and keeps its locks) until the
 * host confirms the folder is gone. Nothing here is a path: the daemon builds paths from the
 * components.
 */
export const folder = pgTable(
  'folder',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    /** The site owner whose tree holds the folder (its `applied_username` is the first path part). */
    principalId: uuid('principal_id').notNull(),
    /** NULL in the `common` scope. */
    environmentId: uuid('environment_id'),
    /** Scope folder name as created: the environment name, or `common`. */
    scope: text().notNull(),
    /** `service` | `volume` */
    kind: text().notNull(),
    /** Folder name: copy of the asset's slug. */
    slug: text().notNull(),
    serviceId: uuid('service_id'),
    storageId: uuid('storage_id'),
    /** `planned` | `present` | `removing` | `orphan` | `missing` */
    state: text().notNull(),
    /**
     * Why the host kept a `removing` folder, in plain words, from its last
     * answer; NULL when it has not refused. Cleared when the row leaves
     * `removing`.
     */
    removalNote: text('removal_note'),
    /** When the owners were told this folder is an orphan; NULL until then and again once it stops being one. */
    orphanAlertedAt: timestamp('orphan_alerted_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    uniqueIndex('uniq_folder_location').on(
      table.serverId,
      table.principalId,
      table.scope,
      table.kind,
      table.slug
    ),
    index('idx_folder_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_folder_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_folder_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    index('idx_folder_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    // The orphan alert reads only the orphans nobody has been told about, and
    // the rows it must clear once they stop being orphans: both stay tiny.
    index('idx_folder_orphan_unalerted')
      .using('btree', table.serverId.asc().nullsLast().op('uuid_ops'))
      .where(sql`${table.state} = 'orphan' AND ${table.orphanAlertedAt} IS NULL`),
    index('idx_folder_orphan_alerted')
      .using('btree', table.state.asc().nullsLast().op('text_ops'))
      .where(sql`${table.orphanAlertedAt} IS NOT NULL`),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'folder_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'folder_principal_id_principal_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'folder_environment_id_environment_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'folder_service_id_service_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'folder_storage_id_storage_id_fk',
    }).onDelete('set null'),
    check('folder_kind_check', sql`kind IN ('service', 'volume')`),
    check(
      'folder_state_check',
      sql`state IN ('planned', 'present', 'removing', 'orphan', 'missing')`
    ),
    check(
      'folder_removal_note_check',
      sql`removal_note IS NULL OR char_length(removal_note) <= 300`
    ),
    check('folder_slug_check', sql.raw(String.raw`slug ~ '${FOLDER_NAME_SQL}' AND slug !~ '\.\.'`)),
    check(
      'folder_scope_check',
      sql.raw(
        `scope = 'common' OR (scope ~ '${ENVIRONMENT_NAME_SQL}' AND scope NOT IN (${RESERVED_ENVIRONMENT_NAMES_SQL}))`
      )
    ),
    // `common` has no environment; every other scope has one, except an orphan
    // found on a host whose environment is not (or no longer) known, and a
    // folder still being removed after its environment was deleted.
    check(
      'folder_common_scope_check',
      sql`(scope = 'common' AND environment_id IS NULL) OR (scope <> 'common' AND (environment_id IS NOT NULL OR state IN ('orphan', 'removing')))`
    ),
    check(
      'folder_asset_kind_check',
      sql`(kind = 'service' AND storage_id IS NULL) OR (kind = 'volume' AND service_id IS NULL)`
    ),
  ]
)

/**
 * An environment using a common asset: a service or volume in the `common`
 * scope of a site owner, which belongs to that owner and not to any one
 * environment. Any environment of any project in the organization can share
 * it. Deleting the environment removes its rows (cascade); deleting the asset
 * is refused while a row names it (restrict), and the routes say so in plain
 * words first.
 */
export const share = pgTable(
  'share',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    environmentId: uuid('environment_id').notNull(),
    serviceId: uuid('service_id'),
    storageId: uuid('storage_id'),
  },
  (table) => [
    index('idx_share_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_share_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    index('idx_share_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    uniqueIndex('uniq_share_environment_service')
      .on(table.environmentId, table.serviceId)
      .where(sql`service_id IS NOT NULL`),
    uniqueIndex('uniq_share_environment_storage')
      .on(table.environmentId, table.storageId)
      .where(sql`storage_id IS NOT NULL`),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'share_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'share_service_id_service_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'share_storage_id_storage_id_fk',
    }).onDelete('restrict'),
    check(
      'share_asset_check',
      sql`(service_id IS NOT NULL AND storage_id IS NULL) OR (service_id IS NULL AND storage_id IS NOT NULL)`
    ),
  ]
)

/**
 * Join edge: the Linux/system principal that runs as / owns a service (the
 * site tree). Deleting a principal removes its edges (cascade); a service
 * still referenced by principals cannot be deleted (restrict), mirroring
 * `container`'s restrict on `service`. Distinct from `binding`, which injects
 * managed-database credentials into a consumer service.
 */
export const tenancy = pgTable(
  'tenancy',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    principalId: uuid('principal_id').notNull(),
    serviceId: uuid('service_id').notNull(),
  },
  (table) => [
    index('idx_tenancy_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'tenancy_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'tenancy_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('tenancy_principal_service_unique').on(table.principalId, table.serviceId),
  ]
)
/**
 * A database login: one engine role on one managed cluster. It is not a
 * principal: a principal is only a site owner's Linux user.
 *
 * `principal_id` names the site owner's Linux user the login shares its name
 * with (the one allowed overlap in the organization's name pool); it is NULL
 * for every login made on its own and for the cluster's own `root` and
 * `replication` logins. The permission settings are real columns:
 * `grant_mode`, `recipe`, `is_all_databases`, `is_tool`, `allowed_sources`,
 * `max_connections`, `access` and `privileges`; the databases a login may use are `scope` rows.
 */
export const login = pgTable(
  'login',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Internal bookkeeping; the grant ledger (what the panel granted) will live here. */
    metadata: jsonb(),
    /** Cluster the role exists on; cascade-deletes with it. */
    managedId: uuid('managed_id').notNull(),
    /** Site owner's Linux user this login shares its name with; NULL otherwise. */
    principalId: uuid('principal_id'),
    /** `root` | `replication` | `user` | `backup` */
    role: text().notNull(),
    /** Name the customer typed (equals `applied_username` for `plain` names and cluster logins). */
    username: varchar({ length: 255 }).notNull(),
    /** Engine role name actually created on the cluster. */
    appliedUsername: varchar('applied_username', { length: 255 }).notNull(),
    /** How `applied_username` was derived from `username`: `plain` | `partial` | `random` */
    nameScheme: text('name_scheme').default('plain').notNull(),
    /** Write-only credential, a `tpsecret` envelope; never returned on GET. */
    password: text(),
    /**
     * Who sets the permissions on reconcile: `recipe` (the panel sets them
     * from the named recipe) or `self` (the owner sets them by hand and the
     * panel never resets them).
     */
    grantMode: text('grant_mode').default('recipe').notNull(),
    /**
     * The named permission set the panel applies when `grant_mode` is
     * `recipe`: `app`, `migrations`, `read-only`, `analyst`, `admin` or
     * `backup`. NULL only for a `self` login.
     */
    recipe: text(),
    /** A read-only reader of every database on the cluster, current and future. */
    isAllDatabases: boolean('is_all_databases').default(false).notNull(),
    /** A database-tool login routes everything to the primary (no read/write split). */
    isTool: boolean('is_tool').default(false).notNull(),
    /**
     * Places the login may connect from: `internal`, `server:<id>` or
     * `address:<ip or range>`. Never empty. Anywhere is the explicit pair
     * `address:0.0.0.0/0` and `address:::/0`.
     */
    allowedSources: text('allowed_sources')
      .array()
      .default(sql`'{internal}'::text[]`)
      .notNull(),
    /** Per-login connection cap; NULL means no cap. */
    maxConnections: integer('max_connections'),
    /** PostgreSQL only: connect straight through the front door; NULL means the owner never chose (default applies). */
    isStraightThrough: boolean('is_straight_through'),
    /** Routing: `read-write` to the primary, `read-only` to read replicas. */
    access: text().default('read-write').notNull(),
    /** What the login may do in each database it can use (`owner`, `read-write`, `read-only`, `admin`). */
    privileges: text()
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
  },
  (table) => [
    index('idx_login_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'login_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'login_principal_id_principal_id_fk',
    }).onDelete('cascade'),
    // One login per site owner's Linux user per cluster.
    uniqueIndex('uniq_login_managed_principal')
      .on(table.managedId, table.principalId)
      .where(sql`${table.principalId} IS NOT NULL`),
    // Engine role names are one namespace per cluster, case-insensitively.
    uniqueIndex('uniq_login_managed_applied_username').on(
      table.managedId,
      sql`lower(btrim((${table.appliedUsername})::text))`
    ),
    // One backup login per cluster.
    uniqueIndex('uniq_login_managed_backup')
      .on(table.managedId)
      .where(sql`${table.role} = 'backup'`),
    check('login_role_check', sql`role IN ('root', 'replication', 'user', 'backup')`),
    check('login_name_scheme_check', sql`name_scheme IN ('plain', 'partial', 'random')`),
    check('login_grant_mode_check', sql`grant_mode IN ('recipe', 'self')`),
    check(
      'login_recipe_check',
      sql`recipe IS NULL OR recipe IN ('app', 'migrations', 'read-only', 'analyst', 'admin', 'backup')`
    ),
    // A panel-set login always names its recipe.
    check('login_recipe_required_check', sql`grant_mode <> 'recipe' OR recipe IS NOT NULL`),
    check('login_allowed_sources_check', sql`cardinality(allowed_sources) BETWEEN 1 AND 100`),
    // A backup login is never left without a place to connect from.
    check('login_backup_sources_check', sql`role <> 'backup' OR cardinality(allowed_sources) >= 1`),
    check('login_access_check', sql`access IN ('read-write', 'read-only')`),
    check('login_max_connections_check', sql`max_connections IS NULL OR max_connections >= 1`),
    check(
      'login_applied_username_format_check',
      sql`(char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)`
    ),
  ]
)
/**
 * One database inside a managed cluster. The row holds what the old
 * `managed.options` lists said: the name, whether it was made with an owner
 * role (Postgres), and the login the customer chose as its owner.
 */
export const managedDatabase = pgTable(
  'database',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Cluster the database lives on; cascade-deletes with it. */
    managedId: uuid('managed_id').notNull(),
    /** Name on the engine, as typed (unique per cluster, case-insensitively). */
    name: varchar({ length: 255 }).notNull(),
    /** Postgres: made with an owner role (`tp_<db>_owner`, `_rw`, `_ro`). */
    isRoleOwned: boolean('is_role_owned').default(false).notNull(),
    /** Postgres: the login the customer chose as owner; NULL means the default no-login owner role. */
    ownerLoginId: uuid('owner_login_id'),
  },
  (table) => [
    uniqueIndex('uniq_database_managed_name').on(table.managedId, sql`lower(${table.name})`),
    index('idx_database_owner_login_id').using(
      'btree',
      table.ownerLoginId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'database_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.ownerLoginId],
      foreignColumns: [login.id],
      name: 'database_owner_login_id_login_id_fk',
    }).onDelete('set null'),
    check('database_name_check', sql`char_length(name) >= 1`),
    check('database_owner_role_check', sql`owner_login_id IS NULL OR is_role_owned`),
  ]
)
/**
 * Which databases a login may use: one row per login and database. What the
 * login may do in them is `login.privileges`.
 */
export const scope = pgTable(
  'scope',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    loginId: uuid('login_id').notNull(),
    databaseId: uuid('database_id').notNull(),
  },
  (table) => [
    unique('uniq_scope_login_database').on(table.loginId, table.databaseId),
    index('idx_scope_database_id').using(
      'btree',
      table.databaseId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.loginId],
      foreignColumns: [login.id],
      name: 'scope_login_id_login_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.databaseId],
      foreignColumns: [managedDatabase.id],
      name: 'scope_database_id_database_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Join edge: database login ↔ consuming compose service.
 * Materializes system-owned `variable` rows (marked via `variable.binding_id`)
 * so DB credentials ride the existing deploy injection rail.
 *
 * FK direction: login CASCADE (login gone → drop bindings); database
 * RESTRICT (a database in use cannot be dropped); service
 * RESTRICT (a service still referenced by bindings cannot be deleted).
 */
export const binding = pgTable(
  'binding',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** The login whose credentials are injected. */
    loginId: uuid('login_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** The database the credentials point at. */
    databaseId: uuid('database_id').notNull(),
    keyPrefix: varchar('key_prefix', { length: 64 }).default('DATABASE').notNull(),
    /** When true, also emit the unprefixed conventional engine keys (PG* / MYSQL_*). API JSON still serializes as `emitEngineDefaults`. */
    isEmitEngineDefaults: boolean('is_emit_engine_defaults').default(true).notNull(),
  },
  (table) => [
    index('idx_binding_database_id').using(
      'btree',
      table.databaseId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_binding_login_id').using('btree', table.loginId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.loginId],
      foreignColumns: [login.id],
      name: 'binding_login_id_login_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.databaseId],
      foreignColumns: [managedDatabase.id],
      name: 'binding_database_id_database_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'binding_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('uniq_binding_service_prefix').on(table.serviceId, table.keyPrefix),
    uniqueIndex('uniq_binding_service_engine_defaults')
      .on(table.serviceId)
      .where(sql`${table.isEmitEngineDefaults}`),
    check(
      'binding_key_prefix_format_check',
      sql`(char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)`
    ),
  ]
)
/**
 * Org-owned sealed secret for storage (and later other) providers.
 * `secret_envelope` is one `tpsecret` payload of provider-specific JSON.
 * Transfer / NFS / S3 public CRUD is not in this slice.
 *
 * `git_deploy_key` is the exception to the JSON rule: its sealed plaintext is
 * the OpenSSH private key **verbatim**, because deploy-prep reseals the
 * envelope for the daemon without opening it and the daemon writes what it
 * decrypts straight to a `0600` identity file. Wrapping it in JSON would mean
 * one of the two sides had to parse it, and neither does.
 */
export const secret = pgTable(
  'secret',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    principalId: uuid('principal_id'),
    provider: text().notNull(),
    name: text().notNull(),
    secretEnvelope: text('secret_envelope').notNull(),
  },
  (table) => [
    index('idx_secret_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_secret_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'secret_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    // `set null`, not `restrict` (schema-constraints, Road-to-0.1.x): a
    // principal delete must not 500 on an org secret that happens to
    // reference it. The secret is org-scoped primarily — the principal
    // link is an optional association, not the thing keeping it alive.
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'secret_principal_id_principal_id_fk',
    }).onDelete('set null'),
    check(
      'secret_provider_check',
      sql`provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key', 'cloudflare', 'cloudflare_tunnel')`
    ),
  ]
)
/**
 * Logical identity of persistent data. Physical copies live on `copy`;
 * service attachments live on `mount`. Scope is at most one of workspace /
 * project / environment / service (zero = organization-wide).
 */
export const storage = pgTable(
  'storage',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    kind: text().notNull(),
    /** Stays `varchar(255)` (schema-text-types audit, 2026-09-16): `storage/routes-helpers.ts` writes `body.name` with no length check and `register-compose-volumes.ts` writes the compose volume key — the column is those writes' only guard. */
    name: varchar({ length: 255 }).notNull(),
    accessMode: text('access_mode').default('single_writer').notNull(),
    retention: text().default('retain').notNull(),
    principalId: uuid('principal_id'),
    /** Sealed file content (`tpsecret` or `tpdaemon`) for `kind=file` entries. */
    contentEnvelope: text('content_envelope'),
    /**
     * `kind = 'volume'` idempotency key (the Compose top-level volume's own
     * key), promoted out of `metadata.composeVolumeKey` (schema-sql-keys,
     * Road-to-0.1.x). Was already a real Postgres constraint via an
     * expression unique index on the jsonb path — this just gives it a
     * column to sit on.
     */
    composeVolumeKey: text('compose_volume_key'),
    /**
     * Folder name under the site owner's tree (`volumes/<slug>`) for volumes
     * the panel owns. Locked once a `folder` row exists. NULL for kinds with
     * no folder and until set.
     */
    slug: text(),
    /**
     * True when the volume folder lives in the `common` scope. Chosen at
     * creation, never changed; a volume not tied to an environment is common.
     */
    isCommon: boolean('is_common').default(false).notNull(),
  },
  (table) => [
    index('idx_storage_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_service_id').using(
      'btree',
      table.serviceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_storage_principal_id').using(
      'btree',
      table.principalId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'storage_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'storage_workspace_id_workspace_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'storage_project_id_project_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'storage_environment_id_environment_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'storage_service_id_service_id_fk',
    }).onDelete('set null'),
    // `set null`, not `restrict` (schema-constraints, Road-to-0.1.x):
    // every other parent FK on this table (workspace/project/environment/
    // service, above) already uses `set null` so a `retain`-flagged row
    // survives its parent's delete — `principal` was the one outlier,
    // and the outlier is what turns a project delete with a retained
    // volume into a real fk_violation 500 today.
    foreignKey({
      columns: [table.principalId],
      foreignColumns: [principal.id],
      name: 'storage_principal_id_principal_id_fk',
    }).onDelete('set null'),
    check('storage_kind_check', sql`kind IN ('volume', 'directory', 'file', 'object')`),
    check(
      'storage_access_mode_check',
      sql`access_mode IN ('single_writer', 'multi_reader', 'multi_writer')`
    ),
    check('storage_retention_check', sql`retention IN ('retain', 'delete')`),
    check(
      'storage_slug_check',
      sql.raw(String.raw`slug IS NULL OR (slug ~ '${FOLDER_NAME_SQL}' AND slug !~ '\.\.')`)
    ),
    check(
      'storage_at_most_one_parent_check',
      sql`((workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) <= 1`
    ),
    /**
     * Compose auto-register idempotency: one `volume` row per
     * `(environment_id, compose_volume_key)` when the key is stamped.
     */
    uniqueIndex('uniq_storage_environment_compose_volume_key')
      .on(table.environmentId, table.composeVolumeKey)
      .where(
        sql`kind = 'volume'
          AND environment_id IS NOT NULL
          AND compose_volume_key IS NOT NULL`
      ),
  ]
)
/**
 * One physical copy / materialization of a storage identity. Local docker/path
 * copies pin `server_id`; remote/shared copies leave it null.
 */
export const storageCopy = pgTable(
  'copy',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    storageId: uuid('storage_id').notNull(),
    serverId: uuid('server_id'),
    secretId: uuid('secret_id'),
    provider: text().notNull(),
    role: text().default('primary').notNull(),
    state: text().default('pending').notNull(),
    path: text(),
    endpoint: text(),
  },
  (table) => [
    index('idx_copy_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    index('idx_copy_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_copy_secret_id').using('btree', table.secretId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'copy_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'copy_server_id_server_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'copy_secret_id_secret_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('uniq_copy_storage_primary')
      .on(table.storageId)
      .where(sql`${table.role} = 'primary'`),
    uniqueIndex('uniq_copy_storage_server_provider')
      .on(table.storageId, table.serverId, table.provider)
      .where(sql`${table.serverId} IS NOT NULL`),
    check(
      'copy_provider_check',
      sql`provider IN ('docker', 'path', 'block', 'nfs', 'cifs', 's3', 's3_compatible', 'sftp', 'ftp', 'webdav')`
    ),
    check('copy_role_check', sql`role IN ('primary', 'replica', 'scratch', 'archive')`),
    check(
      'copy_state_check',
      sql`state IN ('pending', 'materializing', 'ready', 'syncing', 'stale', 'failed', 'retiring')`
    ),
  ]
)
/**
 * A scheduled backup of one target — a managed engine or one local storage
 * copy. The control plane owns the row; each host receives the full set of
 * policies whose target lives on it (`server.backups.reconcile`) and runs
 * them from its own systemd timers, so a run never waits on the control plane.
 *
 * `organization_id` is denormalized, unlike {@link backup}: the target is
 * polymorphic (`managed` or `copy`), so there is no single parent chain to
 * resolve it through, and the policy list is read per organization.
 */
export const retention = pgTable(
  'retention',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    targetKind: text('target_kind').notNull(),
    managedId: uuid('managed_id'),
    copyId: uuid('copy_id'),
    name: text().notNull(),
    /** As authored: a cron expression or alias; translated to `OnCalendar` when pushed. */
    schedule: text().notNull(),
    /** IANA zone the schedule is read in; null means the host's local time. */
    timezone: text(),
    /** Managed target: the database each run dumps; null means the cluster's initial database. */
    database: text(),
    retentionKeep: integer('retention_keep').notNull(),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    nextRunAt: timestamp('next_run_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    createdBy: uuid('created_by'),
  },
  (table) => [
    index('idx_retention_organization_id').using('btree', table.organizationId.asc()),
    index('idx_retention_managed_id').using('btree', table.managedId.asc().nullsLast()),
    index('idx_retention_copy_id').using('btree', table.copyId.asc().nullsLast()),
    index('idx_retention_created_by').on(table.createdBy),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'retention_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.managedId],
      foreignColumns: [managed.id],
      name: 'retention_managed_id_managed_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.copyId],
      foreignColumns: [storageCopy.id],
      name: 'retention_copy_id_copy_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'retention_created_by_user_id_fk',
    }).onDelete('set null'),
    // Mirror BACKUP_TARGET_KINDS (src/features/backups/vocabulary.ts) — pinned by enum-checks.test.ts.
    check('retention_target_kind_check', sql`target_kind IN ('managed', 'copy')`),
    check(
      'retention_target_check',
      sql`(target_kind = 'managed' AND managed_id IS NOT NULL AND copy_id IS NULL) OR (target_kind = 'copy' AND copy_id IS NOT NULL AND managed_id IS NULL)`
    ),
    check('retention_retention_keep_check', sql`retention_keep BETWEEN 1 AND 100`),
  ]
)
/**
 * One finished scheduled run of a {@link retention}, reported by the host
 * that ran it. `run_id` is minted by the daemon and unique per policy, not
 * globally, for the same reason `backup.backup_id` is: a global key would let
 * one host's report shadow another organization's record of the same string.
 */
export const snapshot = pgTable(
  'snapshot',
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
    retentionId: uuid('retention_id').notNull(),
    serverId: uuid('server_id').notNull(),
    runId: text('run_id').notNull(),
    startedAt: timestamp('started_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    finishedAt: timestamp('finished_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    status: text().notNull(),
    error: text(),
    /** The `bk_` id of the artifact the run produced; null when it failed. */
    backupRef: text('backup_ref'),
  },
  (table) => [
    index('idx_snapshot_retention_id_started_at').using(
      'btree',
      table.retentionId.asc(),
      table.startedAt.desc()
    ),
    index('idx_snapshot_server_id').using('btree', table.serverId.asc()),
    uniqueIndex('uniq_snapshot_retention_run_id').on(table.retentionId, table.runId),
    foreignKey({
      columns: [table.retentionId],
      foreignColumns: [retention.id],
      name: 'snapshot_retention_id_retention_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'snapshot_server_id_server_id_fk',
    }).onDelete('cascade'),
    check('snapshot_run_id_format_check', sql`run_id ~ '^[A-Za-z0-9_-]+$'`),
    // Mirror BACKUP_RUN_STATUSES (src/features/backups/vocabulary.ts) — pinned by enum-checks.test.ts.
    check('snapshot_status_check', sql`status IN ('succeeded', 'failed')`),
    check(
      'snapshot_backup_ref_format_check',
      sql`backup_ref IS NULL OR backup_ref ~ '^[A-Za-z0-9_-]+$'`
    ),
  ]
)
/**
 * One completed backup artifact of a local storage copy — the volume twin of
 * {@link backup}, with the same per-target uniqueness and format checks.
 */
export const archive = pgTable(
  'archive',
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
    copyId: uuid('copy_id').notNull(),
    retentionId: uuid('retention_id'),
    backupId: text('backup_id').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text().notNull(),
    path: text().notNull(),
  },
  (table) => [
    index('idx_archive_copy_id_created_at').using(
      'btree',
      table.copyId.asc(),
      table.createdAt.desc()
    ),
    index('idx_archive_retention_id').using('btree', table.retentionId.asc().nullsLast()),
    uniqueIndex('uniq_archive_copy_backup_id').on(table.copyId, table.backupId),
    foreignKey({
      columns: [table.copyId],
      foreignColumns: [storageCopy.id],
      name: 'archive_copy_id_copy_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.retentionId],
      foreignColumns: [retention.id],
      name: 'archive_retention_id_retention_id_fk',
    }).onDelete('set null'),
    check('archive_backup_id_format_check', sql`backup_id ~ '^[A-Za-z0-9_-]+$'`),
    check('archive_checksum_format_check', sql`checksum ~ '^[a-f0-9]{64}$'`),
    check('archive_size_bytes_check', sql`size_bytes >= 0`),
  ]
)
/**
 * Service attachment of a storage identity at a container destination path.
 */
export const mount = pgTable(
  'mount',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    storageId: uuid('storage_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    destinationPath: text('destination_path').notNull(),
    subpath: text(),
    /** API JSON still serializes as `readOnly`. */
    isReadOnly: boolean('is_read_only').default(false).notNull(),
  },
  (table) => [
    index('idx_mount_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'mount_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'mount_service_id_service_id_fk',
    }).onDelete('restrict'),
    unique('uniq_mount_service_destination').on(table.serviceId, table.destinationPath),
  ]
)
/**
 * Org-owned tag definition. Names are labels (app-enforced uniqueness via the
 * per-org normalized unique index); no DB name-format CHECK.
 */
export const tag = pgTable(
  'tag',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: text().notNull(),
    description: text('description'),
    color: varchar({ length: 32 }),
  },
  (table) => [
    uniqueIndex('uniq_tag_organization_name').on(
      table.organizationId,
      sql`lower(btrim((${table.name})::text))`
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tag_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Join edge: one tag applied to exactly one taggable parent. Org is derived
 * through `tag.organization_id` — no `organization_id` column.
 */
export const marker = pgTable(
  'marker',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    tagId: uuid('tag_id').notNull(),
    serverId: uuid('server_id'),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    serviceId: uuid('service_id'),
    datacenterId: uuid('datacenter_id'),
    storageId: uuid('storage_id'),
  },
  (table) => [
    index('idx_marker_tag_id').using('btree', table.tagId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_workspace_id').using(
      'btree',
      table.workspaceId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_project_id').using('btree', table.projectId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_service_id').using('btree', table.serviceId.asc().nullsLast().op('uuid_ops')),
    index('idx_marker_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_marker_storage_id').using('btree', table.storageId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.tagId],
      foreignColumns: [tag.id],
      name: 'marker_tag_id_tag_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'marker_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: 'marker_workspace_id_workspace_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'marker_project_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'marker_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [service.id],
      name: 'marker_service_id_service_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'marker_datacenter_id_datacenter_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.storageId],
      foreignColumns: [storage.id],
      name: 'marker_storage_id_storage_id_fk',
    }).onDelete('cascade'),
    uniqueIndex('uniq_marker_server')
      .on(table.tagId, table.serverId)
      .where(sql`${table.serverId} IS NOT NULL`),
    uniqueIndex('uniq_marker_workspace')
      .on(table.tagId, table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    uniqueIndex('uniq_marker_project')
      .on(table.tagId, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    uniqueIndex('uniq_marker_environment')
      .on(table.tagId, table.environmentId)
      .where(sql`${table.environmentId} IS NOT NULL`),
    uniqueIndex('uniq_marker_service')
      .on(table.tagId, table.serviceId)
      .where(sql`${table.serviceId} IS NOT NULL`),
    uniqueIndex('uniq_marker_datacenter')
      .on(table.tagId, table.datacenterId)
      .where(sql`${table.datacenterId} IS NOT NULL`),
    uniqueIndex('uniq_marker_storage')
      .on(table.tagId, table.storageId)
      .where(sql`${table.storageId} IS NOT NULL`),
    check(
      'marker_exactly_one_parent_check',
      sql`((server_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (datacenter_id IS NOT NULL)::int +
        (storage_id IS NOT NULL)::int) = 1`
    ),
  ]
)
/**
 * A registered Git provider application — a GitHub App, or a GitLab OAuth
 * application.
 *
 * Physical table name is the single lower-case word `forge` (repo rule — see
 * `src/db/table-naming.test.ts`); the exported binding is `forge`.
 *
 * **`organization_id` is the scope switch.** `NULL` means instance-wide: an
 * operator registered it once and every organization may connect through it.
 * A non-null value means the row belongs to that organization alone. This is
 * one table rather than a global settings row plus a per-org table, so every
 * resolution site has exactly one place to look.
 *
 * **`webhook_ref` is how a delivery finds its way back here.** Each app is
 * handed its own webhook URL ending in this token, so an inbound delivery names
 * its app before any secret is consulted — see `src/lib/git/resolve-webhook-app.ts`.
 * It is a routing key, not a credential: HMAC (GitHub) or the token compare
 * (GitLab) still authenticates. Being unguessable only keeps the surface from
 * being enumerable.
 *
 * **`base_url` participates in the unique key** because a GitHub App id is
 * unique per origin, not globally — the same numeric id may exist on github.com
 * and on a GitHub Enterprise Server instance. Holding it per app is also what
 * lets one TurboPanel instance talk to several GitLab origins at once.
 *
 * **All sealed material lives in `envelopes`** as `tpsecret` envelopes
 * (`privateKeyEnvelope`, `clientSecretEnvelope`, `webhookSecretEnvelope`),
 * the same shape `connection.oauth_envelope` uses. Nothing sealed is ever
 * returned over the API; summaries report presence only.
 */
export const forge = pgTable(
  'forge',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** NULL = instance-wide (any organization may use it); set = owned by that org. */
    organizationId: uuid('organization_id'),
    provider: text().notNull(),
    /** Stays `varchar(255)` (schema-text-types audit, 2026-09-16): `forges/handlers.ts` writes the GitHub App's name straight from the provider API with no length check — the column is that write's only guard. */
    name: varchar({ length: 255 }).notNull(),
    /** Origin the app lives on; part of the unique key, so never null. */
    baseUrl: text('base_url').notNull(),
    /** Explicit API origin for GitHub Enterprise Server; derived when null. */
    apiUrl: text('api_url'),
    /**
     * Provider-side application id. For GitHub this is the numeric App id that
     * arrives as `X-GitHub-Hook-Installation-Target-ID`; for GitLab it is the
     * OAuth application id.
     */
    externalAppId: text('external_app_id').notNull(),
    /** GitHub App slug, used to build the install URL. */
    appSlug: varchar('app_slug', { length: 255 }),
    clientId: text('client_id'),
    /** GitLab OAuth redirect URI. */
    redirectUri: text('redirect_uri'),
    /**
     * The public origin this app's deliveries were registered against.
     *
     * An instance may publish several URLs, and the provider stores whichever
     * one it was given at registration — GitHub bakes it into
     * `hook_attributes.url` and nothing revisits it. Picking "the first public
     * origin" at read time, as every other consumer does, would show an
     * operator a URL the provider is not actually using. Null on an app
     * registered before the operator was offered the choice.
     */
    webhookOrigin: text('webhook_origin'),
    /**
     * Whether the provider was told this app is publicly installable.
     *
     * Tracks the instance-wide toggle: a **private** GitHub App can only be
     * installed on the account that owns it, so an app meant to serve several
     * organizations has to be public. Recorded because it is decided once, at
     * creation, and can only be changed on the provider's own settings page.
     */
    isPublic: boolean('is_public').default(false).notNull(),
    /**
     * SSH clone identity for a self-hosted host on a non-standard port.
     *
     * Unused by GitHub App sources, which clone over HTTPS with a minted token;
     * these only shape the `ssh://user@host:port/...` URL for the deploy-key and
     * generic-git lanes.
     */
    customGitUser: varchar('custom_git_user', { length: 64 }),
    customGitPort: integer('custom_git_port'),
    /** Last successful reconcile against the provider's own record of the app. */
    syncedAt: timestamp('synced_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Sealed material: `{ privateKeyEnvelope?, clientSecretEnvelope?,
     * webhookSecretEnvelope? }`, each a `tpsecret` string.
     */
    envelopes: jsonb().notNull(),
    /** Opaque routing token that appears in this app's webhook URL. */
    webhookRef: varchar('webhook_ref', { length: 64 }).notNull(),
    /**
     * GitLab only: HMAC of the webhook token, so a delivery that arrives on the
     * unscoped path resolves in one indexed lookup instead of a scan.
     */
    webhookTokenHash: text('webhook_token_hash'),
  },
  (table) => [
    index('idx_forge_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'forge_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    check('forge_provider_check', sql`provider IN ('github', 'gitlab')`),
    unique('uniq_forge_webhook_ref').on(table.webhookRef),
    unique('uniq_forge_provider_base_external').on(
      table.provider,
      table.baseUrl,
      table.externalAppId
    ),
    unique('uniq_forge_webhook_token_hash').on(table.webhookTokenHash),
  ]
)
/**
 * A Git provider connection granted to one organization.
 *
 * Physical table name is the single lower-case word `connection` (repo rule —
 * see `src/db/table-naming.test.ts`); the exported binding is
 * `gitConnection`.
 *
 * **What "installation" means depends on the provider.** For GitHub it is an
 * App installation and `external_installation_id` is GitHub's numeric id. For
 * GitLab there is no per-repository install: the operator connects one account
 * or group over OAuth, and the id is that account/group's GitLab id.
 *
 * **`forge_id` names the application the grant was made through**, and is what
 * makes a webhook delivery resolvable to exactly one row: an App id alone is
 * shared by every installation of that App, and a GitLab delivery names no
 * connection at all. Without it the only discriminators are provider and
 * external id, which collide across organizations.
 *
 * **No GitHub token columns.** Installation access tokens are minted on demand
 * from the sealed envelopes of the `forge` row this one points at
 * (`src/features/git/github-app-token.ts`) and are never persisted.
 *
 * **GitLab is the exception, and `oauth_envelope` is why.** OAuth hands out an
 * access + refresh pair and rotates the refresh half on every use, so the pair
 * must be stored or the connection dies at the next deploy. It is held here as
 * jsonb of `tpsecret` envelopes (never plaintext), scoped to
 * `provider = 'gitlab'` — see `src/features/git/gitlab-oauth-token.ts`.
 */
export const gitConnection = pgTable(
  'connection',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** The registered application this connection was granted through. */
    forgeId: uuid('forge_id').notNull(),
    provider: text().notNull(),
    /** Provider-side id: a GitHub App installation, or a GitLab account/group. */
    externalInstallationId: text('external_installation_id').notNull(),
    accountLogin: varchar('account_login', { length: 255 }),
    accountType: text('account_type'),
    /** Set while the provider reports the installation as suspended. */
    suspendedAt: timestamp('suspended_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /**
     * Sealed OAuth token pair for `provider = 'gitlab'` (null for GitHub).
     *
     * `{ accessTokenEnvelope, refreshTokenEnvelope, expiresAt, scope }`, where
     * both envelopes are `tpsecret` strings.
     */
    oauthEnvelope: jsonb('oauth_envelope'),
  },
  (table) => [
    index('idx_connection_forge_id').using('btree', table.forgeId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'connection_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.forgeId],
      foreignColumns: [forge.id],
      name: 'connection_forge_id_forge_id_fk',
    }).onDelete('cascade'),
    check('connection_provider_check', sql`provider IN ('github', 'gitlab')`),
    unique('uniq_connection_organization_forge_external').on(
      table.organizationId,
      table.forgeId,
      table.externalInstallationId
    ),
    /**
     * A GitHub App installation belongs to one organization per App — across
     * the whole instance, not per organization. The App's private key mints
     * tokens for an installation regardless of which organization asked, so a
     * second organization recording the same installation on a shared
     * (instance-wide) App would read the first one's repositories. The
     * org-scoped unique above still lets a reconnect from the owning
     * organization be an update; this one makes a cross-organization claim a
     * `23505` the callback maps to `claimed`. GitHub only: a GitLab
     * `external_installation_id` is the GitLab user, whose OAuth grant is
     * per-organization by construction.
     */
    uniqueIndex('uniq_connection_forge_external_github')
      .on(table.forgeId, table.externalInstallationId)
      .where(sql`${table.provider} = 'github'`),
  ]
)
/**
 * A Git repository connected to an organization — exactly one row per
 * repository per organization.
 *
 * The row is a pure org-level registry entry: what attaches it to workloads is
 * `project.repository_id` and the compose `x-turbopanel.source.sourceId`
 * references, never a column here. (It once carried `service_id` /
 * `environment_id` parent columns mirroring `storage`; nothing modern wrote
 * them, and they made a repository look scoped to a workload it merely
 * predated. Dropped rather than deprecated — pre-MVP.)
 *
 * `repository_url` is stored **canonicalized** (`canonicalizeRepositoryUrl` in
 * `src/features/git/clone-url.ts`: lower-cased host, `.git` suffix, no trailing
 * slash) so the per-organization unique below actually deduplicates spellings
 * of the same repository.
 *
 * `detected_default_branch` / `default_branch_checked_at` /
 * `last_inspected_at` / `last_inspected_commit_sha` are provider-observed
 * facts the instance refreshes over time — real columns rather than
 * `metadata` because every row carries them, not sparse per-repo extras.
 * `metadata` remains for anything genuinely sparse; `options` holds operator
 * policy and trigger state.
 */
export const repository = pgTable(
  'repository',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    /** Provider connection that authorizes clones; null for deploy-key sources. */
    connectionId: uuid('connection_id'),
    /** Deploy key for generic-SSH and deploy-key-authorized GitLab sources. */
    secretId: uuid('secret_id'),
    provider: text().notNull(),
    repositoryUrl: text('repository_url').notNull(),
    /** Provider-side repository/project id (numeric, as text) for webhook matching. */
    repositoryExternalId: text('repository_external_id'),
    defaultBranch: varchar('default_branch', { length: 255 }),
    /** Relative checkout subdirectory; same rule as compose `x-turbopanel.root`. */
    subdirectory: text(),
    autoDeploy: text('auto_deploy').default('disabled').notNull(),
    /** Provider-reported default branch from the most recent refresh/inspect. */
    detectedDefaultBranch: varchar('detected_default_branch', { length: 255 }),
    defaultBranchCheckedAt: timestamp('default_branch_checked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastInspectedAt: timestamp('last_inspected_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastInspectedCommitSha: text('last_inspected_commit_sha'),
  },
  (table) => [
    /** The pushed-repository lookup, and the connection foreign key. */
    index('idx_repository_connection_external').using(
      'btree',
      table.connectionId.asc().nullsLast(),
      table.repositoryExternalId.asc().nullsLast()
    ),
    index('idx_repository_secret_id').using(
      'btree',
      table.secretId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'repository_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [gitConnection.id],
      name: 'repository_connection_id_connection_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'repository_secret_id_secret_id_fk',
    }).onDelete('set null'),
    /**
     * One repository binds once per organization.
     *
     * `repository_url` is canonicalized before every write, so this holds for
     * every lane — provider-attached and deploy-key/generic-git alike. (The
     * connection-keyed unique below cannot cover the key lanes: their
     * `connection_id` is null and Postgres treats nulls as distinct.) It is
     * also what makes the find-or-create in `POST /repositories` and
     * `POST /repositories/attach` atomic rather than a check-then-insert race.
     */
    unique('uniq_repository_organization_url').on(table.organizationId, table.repositoryUrl),
    /**
     * Same guarantee keyed the way webhooks match: the provider-side repo id
     * survives renames and transfers, which change `repository_url`.
     */
    unique('uniq_repository_organization_connection_repository').on(
      table.organizationId,
      table.connectionId,
      table.repositoryExternalId
    ),
    check('repository_provider_check', sql`provider IN ('github', 'gitlab', 'git')`),
    check(
      'repository_auto_deploy_check',
      sql`auto_deploy IN ('immediate', 'checks_passed', 'disabled')`
    ),
  ]
)
/**
 * Which environment or project follows which repository: a compose document
 * names a repository at `services.<name>.x-turbopanel.source.sourceId`, and a
 * push must find the environments that reaches without scanning every options
 * column. A row for a project reaches every environment of that project. The
 * rows are derived from the options and kept in step by
 * `features/git/watch-records.ts`.
 */
export const watch = pgTable(
  'watch',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    repositoryId: uuid('repository_id').notNull(),
    /** Set when an environment's own compose names the repository. */
    environmentId: uuid('environment_id'),
    /** Set when the project's compose names it (reaches every environment of the project). */
    projectId: uuid('project_id'),
  },
  (table) => [
    uniqueIndex('uniq_watch_repository_environment')
      .on(table.repositoryId, table.environmentId)
      .where(sql`${table.environmentId} IS NOT NULL`),
    uniqueIndex('uniq_watch_repository_project')
      .on(table.repositoryId, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    index('idx_watch_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
    index('idx_watch_project_id').using('btree', table.projectId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repository.id],
      name: 'watch_repository_id_repository_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.environmentId],
      foreignColumns: [environment.id],
      name: 'watch_environment_id_environment_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'watch_project_id_project_id_fk',
    }).onDelete('cascade'),
    check(
      'watch_target_check',
      sql`(environment_id IS NOT NULL AND project_id IS NULL) OR (environment_id IS NULL AND project_id IS NOT NULL)`
    ),
  ]
)
/**
 * Inbound webhook delivery ledger — replay protection only.
 *
 * Physical table name is the single lower-case word `delivery` (repo rule —
 * see `src/db/table-naming.test.ts`); the exported binding keeps the
 * fully-qualified `webhookDelivery` name used across the codebase.
 *
 * Not git-only: every kind the gate in `src/webhook/gate.ts` admits claims
 * its delivery id here — GitHub and GitLab deliveries, and Stripe events.
 *
 * **Deliberately org-agnostic.** A delivery id arrives in the request headers
 * (or, for Stripe, in the event body) before the signature has been checked
 * and long before the payload has been matched to a tenant, so there is no
 * organization to scope the row to.
 * The row holds no secret and nothing user-visible. Git deliveries store
 * only the provider delivery id plus the moment it was accepted
 * (`createdAt`), so a redelivery can be answered without re-running side
 * effects. Stripe rows additionally carry the minimal object ref
 * (`objectId` / `objectType`) until projection has settled (`projectedAt`),
 * so a crash after the 2xx cannot drop entitlement: the maintenance sweep
 * retries pending Stripe work rather than treating the claim as done.
 *
 * Rows are pruned by the shared maintenance sweep after
 * `WEBHOOK_DELIVERY_RETENTION_MS` (see `src/features/webhook-delivery/webhook-delivery-records.ts`)
 * — GitHub retries a failed delivery for hours, not weeks. Pending Stripe
 * projections (`provider = 'stripe' AND projected_at IS NULL`) are excluded
 * from that prune until they settle.
 */
export const webhookDelivery = pgTable(
  'delivery',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    /** Moment the delivery was accepted; doubles as the sweep's age cursor. */
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    provider: text().notNull(),
    /** Provider-side delivery id (GitHub `X-GitHub-Delivery`; GitLab's event
     * UUID, else a digest of the body — see `src/features/git/gitlab-webhook.ts`). */
    externalDeliveryId: text('external_delivery_id').notNull(),
    /** Provider event name (`push`, `check_suite`, …) — tracing only. */
    event: text(),
    /** Stripe `data.object.id` — durable projection handoff; unused for git. */
    objectId: text('object_id'),
    /** Stripe `data.object.object` — durable projection handoff; unused for git. */
    objectType: text('object_type'),
    /**
     * When the Stripe projection settled (success, skip, or permanent error).
     * `null` means pending retry. Git rows stay null.
     */
    projectedAt: timestamp('projected_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('idx_delivery_created_at').using('btree', table.createdAt.asc()),
    /** The per-minute projection retry: least recently attempted first. */
    index('idx_delivery_pending')
      .using('btree', table.updatedAt.asc())
      .where(
        sql`${table.provider} = 'stripe' AND ${table.projectedAt} IS NULL AND ${table.objectId} IS NOT NULL`
      ),
    // Widened beyond the git kinds when billing landed: the same ledger claims
    // Stripe event ids (`src/webhook/billing/stripe.ts`).
    check('delivery_provider_check', sql`provider IN ('github', 'gitlab', 'stripe')`),
    unique('uniq_delivery_provider_external').on(table.provider, table.externalDeliveryId),
  ]
)
export const grant = pgTable(
  'permission',
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
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    permission: text().notNull(),
  },
  (table) => [
    unique('permission_unique').on(
      table.entityType,
      table.entityId,
      table.actorType,
      table.actorId,
      table.permission
    ),
    index('idx_permission_actor').on(table.actorType, table.actorId),
    // Mirror `SUBJECT_TYPES` / `GRANT_ENTITY_TYPES` (src/client/authz/catalog.ts) —
    // pinned by enum-checks.test.ts.
    check('permission_actor_type_check', sql`actor_type IN ('user', 'team', 'organization')`),
    check(
      'permission_entity_type_check',
      sql`entity_type IN ('organization', 'workspace', 'environment', 'project', 'service', 'server', 'hosting', 'variable', 'managed', 'container', 'tls', 'team')`
    ),
  ]
)
/**
 * Append-only record of security-relevant operator actions.
 *
 * Revoking a daemon key, deleting a server, changing a member's grants,
 * editing a forge's credentials, flipping an organization gate: each happened
 * with no record of who did it or when, so an incident could not be
 * reconstructed afterwards — and three separate guards in this codebase
 * already promised "audited" in their own comments. This is that record.
 *
 * Nothing ever updates or deletes a row, which is why there is no
 * `updated_at`: an audit trail a compromised operator can edit is not one.
 * `context` is a small jsonb bag for the few facts worth keeping beside the
 * action (a before/after where it is cheap, the reason string a route already
 * carries); secrets never go in it — the rule is the same as `setting`'s.
 */
export const audit = pgTable(
  'audit',
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
    /**
     * The organization the action belongs to; the org-scoped read filters by
     * it. Null for an instance-wide action (a superadmin editing a forge that
     * belongs to no organization) — the most privileged case, which must
     * still be recorded even though no organization can read it.
     */
    organizationId: uuid('organization_id'),
    /**
     * Who acted. Null only for an action the platform took on nobody's
     * behalf (a scheduled sweep), never for an operator action. A plain id on
     * purpose, with no foreign key: the trail keeps the id after the account
     * is deleted, and `actor_email` still names who it was.
     */
    actorUserId: uuid('actor_user_id'),
    /** Denormalized on purpose: the trail must survive the account's deletion. */
    actorEmail: text('actor_email'),
    /** Dot-joined verb, e.g. `server.daemon_key.revoke` — AUDIT_ACTIONS. */
    action: text().notNull(),
    /** What it was done to: a catalog entity kind, or `organization`. */
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    /** Small, non-secret facts worth keeping beside the action. */
    context: jsonb(),
  },
  (table) => [
    /** The organization audit list: newest first, the id as tie-break so no sort is needed. */
    index('idx_audit_organization_recent').on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc()
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'audit_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
export const session = pgTable(
  'session',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    /** Server-generated, never typed; `text` so a longer token format never needs DDL (schema-text-types). */
    token: text().notNull(),
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    key: text().notNull(),
    value: jsonb().notNull(),
  },
  (table) => [unique('setting_key_unique').on(table.key)]
)
/**
 * One uploaded control-plane certificate pair. Several `origin` rows may
 * reference the same pair (`uploaded_cert_id`) when a wildcard covers them.
 * `key_pem` is a sealed `tpsecret` envelope. This is instance TLS material,
 * never an organization `tls` row.
 */
export const instanceUploadedCertificate = pgTable('certificate', {
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
  label: text().notNull(),
  certPem: text('cert_pem').notNull(),
  keyPem: text('key_pem').notNull(),
  dnsNames: jsonb('dns_names').notNull(),
  notAfter: timestamp('not_after', {
    precision: 3,
    withTimezone: true,
    mode: 'string',
  }).notNull(),
})
/**
 * One public name for this control plane. Replaces the flat
 * `TURBOPANEL_PUBLIC_URLS` setting as the source of truth; that setting stays
 * as a compatibility projection. Certificate source and Let's Encrypt attempt
 * state live on the row because a single jsonb setting cannot hold them.
 */
export const instanceHostname = pgTable(
  'origin',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Normalized public URL entry (`parsePublicUrlEntries` form). */
    host: text().notNull(),
    /** `platform-ca` | `uploaded` | `lets-encrypt` */
    source: text().notNull(),
    uploadedCertId: uuid('uploaded_cert_id'),
    acmeLastAttemptAt: timestamp('acme_last_attempt_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    acmeLastError: text('acme_last_error'),
    notAfter: timestamp('not_after', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    unique('origin_host_unique').on(table.host),
    index('idx_origin_uploaded_cert_id').using(
      'btree',
      table.uploadedCertId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.uploadedCertId],
      foreignColumns: [instanceUploadedCertificate.id],
      name: 'origin_uploaded_cert_id_certificate_id_fk',
    }).onDelete('set null'),
    check('origin_source_check', sql`source IN ('platform-ca', 'uploaded', 'lets-encrypt')`),
    check(
      'origin_uploaded_cert_check',
      sql`(source <> 'uploaded') OR (uploaded_cert_id IS NOT NULL)`
    ),
  ]
)
/**
 * The cross-isolate CAS lease, promoted out of four identical `setting`-row
 * protocols (schema-child-tables, Road-to-0.1.x): `offline-sweep-lease.ts`,
 * `leaf-renewal-sweep.ts`, `reencrypt-secrets.ts`, `billing/quantity-lock.ts`.
 * Each file keeps its own exported functions and release semantics — 2
 * tombstone the row on release (empty `owner` + expired `expires_at`), 2
 * hard-delete it — this table only changes where the row lives.
 *
 * `organization_id` is null for the 3 globally-scoped leases and set for the
 * per-organization billing lease; `NULLS NOT DISTINCT` on the unique
 * constraint is load-bearing here — standard Postgres uniqueness treats two
 * NULLs as distinct, which would silently allow more than one row for the
 * same global lease `name`. `cursor` is populated by exactly one caller
 * (leaf renewal's keyset resume point) and must stay part of every steal's
 * compare-and-swap alongside `owner` / `expires_at`, matching the old
 * `eq(setting.value, existing.value)` whole-JSON compare exactly — a
 * naive owner-and-expiry-only CAS would silently drop a concurrent cursor
 * change from the comparison and widen the existing steal race.
 */
export const lease = pgTable(
  'lease',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    name: text().notNull(),
    organizationId: uuid('organization_id'),
    owner: text().notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    cursor: jsonb(),
  },
  (table) => [
    unique('uniq_lease_name_organization').on(table.name, table.organizationId).nullsNotDistinct(),
    index('idx_lease_organization_id').on(table.organizationId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'lease_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
export const account = pgTable(
  'account',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    userId: uuid('user_id').notNull(),
    providerId: text('provider_id').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    password: text(),
  },
  (table) => [
    index('idx_account_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    unique('uniq_account_provider_user').on(table.providerId, table.providerUserId),
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
    createdAt: timestamp('created_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    name: text(),
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Stays `varchar(255)` (schema-text-types audit, 2026-09-16): `oauth-http.ts` writes the OAuth profile name straight from the provider with no length check — the column is that write's only guard. */
    name: varchar({ length: 255 }),
    email: varchar({ length: 255 }).notNull(),
    isEmailVerified: boolean('is_email_verified').default(false).notNull(),
    is2FaEnabled: boolean('is_2fa_enabled').default(false).notNull(),
    isDisabled: boolean('is_disabled').default(false).notNull(),
    role: text().default('user').notNull(),
    /** IANA zone the person's quiet hours are read in; null means UTC. */
    timeZone: varchar('time_zone', { length: 64 }),
  },
  (table) => [
    unique('user_email_unique').on(table.email),
    check(
      'user_name_format_check',
      sql`(name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))`
    ),
    // Mirrors the role constants in src/client/authn/session-store.ts — pinned by enum-checks.test.ts.
    check('user_role_check', sql`role IN ('user', 'admin', 'superadmin')`),
  ]
)
export const twoFactor = pgTable(
  'totp',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    userId: uuid('user_id').notNull(),
    /** Sealed `tpsecret` envelope — not plaintext. */
    secret: text().notNull(),
    isVerified: boolean('is_verified').default(false).notNull(),
    backupCodes: text('backup_codes').notNull(),
  },
  (table) => [
    unique('uniq_totp_user_id').on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'totp_user_id_user_id_fk',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    identifier: varchar({ length: 255 }).notNull(),
    value: text().notNull(),
  },
  (table) => [unique('verification_identifier_unique').on(table.identifier)]
)

/**
 * Notifications — the tables behind "an event happened and someone should
 * hear about it". Four tables, added after the freeze (migration 0002, renamed to
 * single words in 0003 per the table-naming rule), one
 * data model for self-hosted, High Availability and the store apps
 * (decided 2026-09-18):
 *
 * - `channel` — an address something can be delivered to. Owned
 *   by the instance (an operator's alert webhook), an organization, or a user.
 *   `address` is a `tpsecret` envelope wherever the address is a credential —
 *   every webhook URL is (the path is the secret) and so is a push token;
 *   an email address is stored plain. Everything sealed here is a stage of
 *   the re-encrypt sweep.
 * - `rule` — which events reach a channel. No rule means the
 *   channel receives nothing; `*` means everything at or above its severity
 *   floor. Inbox rows need no rule.
 * - `notification` — one row per event × recipient: the bell's inbox.
 * - `attempt` — one delivery-attempt ledger row per event × channel,
 *   written before the send so a crash mid-send leaves a pending row rather
 *   than silence; bounded retries on the maintenance tick.
 */
export const notificationChannel = pgTable(
  'channel',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    /** Who owns the channel — NOTIFICATION_CHANNEL_SCOPES; the owner columns follow the scope. */
    scope: text().notNull(),
    organizationId: uuid('organization_id'),
    userId: uuid('user_id'),
    /** NOTIFICATION_CHANNEL_KINDS. */
    kind: text().notNull(),
    /** What the owner calls it: "Ops Slack", "my phone". */
    label: text().notNull(),
    /** Sealed (`tpsecret`) for every kind but `email`, where it is the plain address. */
    address: text().notNull(),
    /** Sealed HMAC key for the generic `webhook` kind; null for the rest. */
    signingSecret: text('signing_secret'),
    /** When the address was confirmed (an email verification, a Telegram /start). Null = unverified. */
    verifiedAt: timestamp('verified_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** A disabled channel keeps its rules and receives nothing. */
    disabledAt: timestamp('disabled_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    createdByUserId: uuid('created_by_user_id'),
    /** NOTIFICATION_DIGEST_CADENCES; null = every event is sent as it happens. */
    digestCadence: text('digest_cadence'),
    /** Quiet hours start, minutes after local midnight (0-1439); null with `quietEndMinute` = no quiet hours. */
    quietStartMinute: smallint('quiet_start_minute'),
    /** Quiet hours end, minutes after local midnight (0-1439); the window may wrap midnight. */
    quietEndMinute: smallint('quiet_end_minute'),
  },
  (table) => [
    check('channel_scope_check', sql`scope IN ('instance', 'organization', 'user')`),
    check(
      'channel_kind_check',
      sql`kind IN ('email', 'webhook', 'slack', 'discord', 'telegram', 'push')`
    ),
    // The owner columns say what the scope says, and nothing else.
    check(
      'channel_owner_check',
      sql`(scope = 'instance' AND organization_id IS NULL AND user_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)`
    ),
    check(
      'channel_digest_cadence_check',
      sql`digest_cadence IS NULL OR digest_cadence IN ('hourly', 'daily')`
    ),
    // Quiet hours are both ends or neither, each a minute of the day, and not an empty window.
    check(
      'channel_quiet_hours_check',
      sql`(quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR (quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND quiet_start_minute <> quiet_end_minute)`
    ),
    index('idx_channel_organization').on(table.organizationId),
    index('idx_channel_user').on(table.userId),
    index('idx_channel_created_by_user_id').on(table.createdByUserId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'channel_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'channel_user_id_user_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [user.id],
      name: 'channel_created_by_user_id_user_id_fk',
    }).onDelete('set null'),
  ]
)

export const notificationRule = pgTable(
  'rule',
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
    channelId: uuid('channel_id').notNull(),
    /** One event code, or `*` — NOTIFICATION_RULE_EVENTS. */
    event: text().notNull(),
    /** Deliver only at or above this — NOTIFICATION_SEVERITIES. */
    minSeverity: text('min_severity').default('info').notNull(),
  },
  (table) => [
    check(
      'rule_event_check',
      sql`event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found')`
    ),
    check('rule_min_severity_check', sql`min_severity IN ('info', 'warning', 'critical')`),
    uniqueIndex('uniq_rule_channel_event').on(table.channelId, table.event),
    foreignKey({
      columns: [table.channelId],
      foreignColumns: [notificationChannel.id],
      name: 'rule_channel_id_channel_id_fk',
    }).onDelete('cascade'),
  ]
)

export const notification = pgTable(
  'notification',
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
    /** The recipient — one row per person the event reached. */
    userId: uuid('user_id').notNull(),
    /** Null for an instance-scoped event. */
    organizationId: uuid('organization_id'),
    /** NOTIFICATION_EVENTS. */
    event: text().notNull(),
    /** NOTIFICATION_SEVERITIES. */
    severity: text().notNull(),
    title: text().notNull(),
    body: text(),
    /** What it is about: a catalog entity kind and id, so the bell can link to it. */
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    /** The small non-secret context the sentence was rendered from. */
    context: jsonb(),
    readAt: timestamp('read_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    dismissedAt: timestamp('dismissed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    check(
      'notification_event_check',
      sql`event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found')`
    ),
    check('notification_severity_check', sql`severity IN ('info', 'warning', 'critical')`),
    index('idx_notification_user_created').on(table.userId, table.createdAt.desc()),
    /** The unread count (polled every minute per open browser) and mark-all-read. */
    index('idx_notification_unread')
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL AND ${table.dismissedAt} IS NULL`),
    index('idx_notification_organization_id').on(table.organizationId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'notification_user_id_user_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'notification_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)

export const notificationDelivery = pgTable(
  'attempt',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    channelId: uuid('channel_id').notNull(),
    /** Null for an instance-scoped event. */
    organizationId: uuid('organization_id'),
    /** NOTIFICATION_EVENTS. */
    event: text().notNull(),
    /** NOTIFICATION_SEVERITIES. */
    severity: text().notNull(),
    /** The rendered, non-secret message: title, body, context, target. */
    payload: jsonb(),
    /** NOTIFICATION_DELIVERY_STATUSES. */
    status: text().default('pending').notNull(),
    attempts: integer().default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    sentAt: timestamp('sent_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    /** The last failure, as a short code or an HTTP status — never a body, never the address. */
    lastError: text('last_error'),
  },
  (table) => [
    check(
      'attempt_event_check',
      sql`event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found')`
    ),
    check('attempt_severity_check', sql`severity IN ('info', 'warning', 'critical')`),
    check(
      'attempt_status_check',
      sql`status IN ('pending', 'sent', 'failed', 'abandoned', 'held')`
    ),
    index('idx_attempt_pending').on(table.status, table.nextAttemptAt),
    // The digest sweep reads only the rows waiting for a window to end.
    index('idx_attempt_held')
      .on(table.channelId, table.createdAt)
      .where(sql`status = 'held'`),
    index('idx_attempt_channel_created').on(table.channelId, table.createdAt.desc()),
    index('idx_attempt_organization_id').on(table.organizationId),
    foreignKey({
      columns: [table.channelId],
      foreignColumns: [notificationChannel.id],
      name: 'attempt_channel_id_channel_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'attempt_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * One firewall rule an operator typed, in the vocabulary of the
 * `server.firewall.reconcile` wire contract (`scope`, `action`, `proto`,
 * `ports`), so a stored rule maps onto a wire entry unchanged. Rules derived
 * from what is deployed (published ports, the panel's own port, SSH) are
 * computed when a server's ruleset is built and never stored here.
 *
 * `server_id` null means every server in the organization. `source_kind`
 * names who the rule is about; only `addresses` carries `source_addresses`.
 * `label` doubles as the rule's wire comment, so it follows the contract's
 * comment alphabet.
 */
export const edict = pgTable(
  'edict',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    organizationId: uuid('organization_id').notNull(),
    serverId: uuid('server_id'),
    label: text().notNull(),
    scope: text().notNull(),
    action: text().notNull(),
    proto: text().notNull(),
    /** One port (`8443`) or an inclusive ascending range (`5432-5440`); null means every port. */
    ports: text(),
    sourceKind: text('source_kind').notNull(),
    /** Explicit addresses or CIDRs; only for `source_kind = 'addresses'`, otherwise empty. */
    sourceAddresses: inet('source_addresses')
      .array()
      .notNull()
      .default(sql`'{}'::inet[]`),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    createdBy: uuid('created_by'),
  },
  (table) => [
    index('idx_edict_organization_id').using('btree', table.organizationId.asc()),
    index('idx_edict_server_id').using('btree', table.serverId.asc().nullsLast()),
    index('idx_edict_created_by').on(table.createdBy),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'edict_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'edict_server_id_server_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'edict_created_by_user_id_fk',
    }).onDelete('set null'),
    // Mirror the arrays in src/features/firewall/vocabulary.ts — pinned by enum-checks.test.ts.
    check('edict_scope_check', sql`scope IN ('host', 'published')`),
    check('edict_action_check', sql`action IN ('accept', 'drop', 'reject')`),
    check('edict_proto_check', sql`proto IN ('tcp', 'udp', 'any')`),
    check(
      'edict_source_kind_check',
      sql`source_kind IN ('any', 'servers', 'datacenter', 'fabric', 'addresses')`
    ),
    check('edict_label_format_check', sql`label ~ '^[A-Za-z0-9 ._:/-]{1,48}$'`),
    check('edict_ports_format_check', sql`ports IS NULL OR ports ~ '^[0-9]{1,5}(-[0-9]{1,5})?$'`),
    // Ports mean something only to tcp and udp.
    check('edict_ports_proto_check', sql`ports IS NULL OR proto <> 'any'`),
    // Only a block may say "every port"; an allow names its ports.
    check('edict_accept_ports_check', sql`action <> 'accept' OR ports IS NOT NULL`),
    check(
      'edict_source_addresses_check',
      sql`(source_kind = 'addresses' AND cardinality(source_addresses) BETWEEN 1 AND 256) OR (source_kind <> 'addresses' AND cardinality(source_addresses) = 0)`
    ),
  ]
)
/**
 * One server's firewall state, one row per server. `mode` decides whether
 * the computed ruleset is only shown (`observe`, the default), enforced
 * (`managed`) or left alone (`off`). `generation` rises by one each time the
 * desired state changes, so a host can tell a stale push from a current one.
 * The remaining columns record the last apply and whether it was kept.
 */
export const bulwark = pgTable(
  'bulwark',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    serverId: uuid('server_id').notNull(),
    mode: text().default('observe').notNull(),
    generation: integer().default(0).notNull(),
    /** sha256 hex of the rendered rulesets the host last reported; the drift key. */
    lastDigest: text('last_digest'),
    /** What the host last answered (applied or refused, rule count, warnings); null before any report. */
    lastResult: jsonb('last_result'),
    /** `kind` of the record in `last_result` (`preview`, `apply` or `remove`); the firewall sweep filters on it. */
    lastKind: text('last_kind'),
    state: text().default('idle').notNull(),
    /** When an unconfirmed ruleset is undone by the host's guard; null unless `state` is `pending`. */
    deadlineAt: timestamp('deadline_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastAppliedAt: timestamp('last_applied_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    confirmedAt: timestamp('confirmed_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    uniqueIndex('uniq_bulwark_server_id').using('btree', table.serverId.asc()),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'bulwark_server_id_server_id_fk',
    }).onDelete('cascade'),
    // Mirror FIREWALL_MODES / FIREWALL_STATES — pinned by enum-checks.test.ts.
    check('bulwark_mode_check', sql`mode IN ('observe', 'managed', 'off')`),
    check('bulwark_state_check', sql`state IN ('idle', 'pending', 'confirmed', 'rolled_back')`),
    check('bulwark_generation_check', sql`generation >= 0`),
    check(
      'bulwark_last_kind_check',
      sql`last_kind IS NULL OR last_kind IN ('preview', 'apply', 'remove')`
    ),
    check(
      'bulwark_digest_format_check',
      sql`last_digest IS NULL OR last_digest ~ '^[a-f0-9]{64}$'`
    ),
  ]
)

/**
 * A provider account an organization connected for tunnels (a Cloudflare
 * account today). Provider-neutral: the provider is a value, its own details
 * live in `options`. `external_account_id` is null for a provider with no
 * account concept. Tokens are never stored here: see `badge`.
 */
export const carrier = pgTable(
  'carrier',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    provider: text().notNull(),
    name: text().notNull(),
    externalAccountId: text('external_account_id'),
    status: text().default('active').notNull(),
  },
  (table) => [
    index('idx_carrier_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    // Postgres treats NULLs as distinct, so a provider with no account id may hold several.
    unique('uniq_carrier_organization_id_provider_external_account_id').on(
      table.organizationId,
      table.provider,
      table.externalAccountId
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'carrier_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    // Mirror TUNNEL_PROVIDERS / CARRIER_STATUSES — pinned by enum-checks.test.ts.
    check('carrier_provider_check', sql`provider IN ('cloudflare')`),
    check('carrier_status_check', sql`status IN ('active', 'attention')`),
  ]
)

/**
 * One API token on a carrier. The token itself is sealed in the `secret` row
 * `secret_id` points at; this row holds only the label, what the token can do
 * and its last check. Removing a badge removes its secret row too.
 */
export const badge = pgTable(
  'badge',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    carrierId: uuid('carrier_id').notNull(),
    secretId: uuid('secret_id').notNull(),
    label: text().notNull(),
    /** What the last check found the token can do: `{ tunnels, dns, certificates }` booleans. */
    capabilities: jsonb().default({}).notNull(),
    /** Last 4 characters of the token, kept so a screen can tell tokens apart. */
    lastFour: text('last_four').notNull(),
    lastCheckedAt: timestamp('last_checked_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    status: text().default('active').notNull(),
  },
  (table) => [
    index('idx_badge_carrier_id').using('btree', table.carrierId.asc().nullsLast().op('uuid_ops')),
    unique('uniq_badge_secret_id').on(table.secretId),
    foreignKey({
      columns: [table.carrierId],
      foreignColumns: [carrier.id],
      name: 'badge_carrier_id_carrier_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'badge_secret_id_secret_id_fk',
    }).onDelete('restrict'),
    check('badge_status_check', sql`status IN ('active', 'attention')`),
  ]
)

/**
 * A tunnel an organization created: a named path from a provider's edge to
 * connectors on its servers. `secret_id` is the sealed run token the
 * connectors use. `placement` says where connectors run; `datacenter_id` is
 * the datacenter that `all` means every server of, and it is nullable. It does
 * not limit the tunnel to one datacenter: connectors may later run in several.
 */
export const tunnel = pgTable(
  'tunnel',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    carrierId: uuid('carrier_id'),
    provider: text().notNull(),
    name: text().notNull(),
    externalId: text('external_id'),
    placement: text().default('chosen').notNull(),
    datacenterId: uuid('datacenter_id'),
    secretId: uuid('secret_id'),
    status: text().default('pending').notNull(),
  },
  (table) => [
    index('idx_tunnel_carrier_id').using('btree', table.carrierId.asc().nullsLast().op('uuid_ops')),
    index('idx_tunnel_datacenter_id').using(
      'btree',
      table.datacenterId.asc().nullsLast().op('uuid_ops')
    ),
    unique('uniq_tunnel_organization_id_name').on(table.organizationId, table.name),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'tunnel_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.carrierId],
      foreignColumns: [carrier.id],
      name: 'tunnel_carrier_id_carrier_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.datacenterId],
      foreignColumns: [datacenter.id],
      name: 'tunnel_datacenter_id_datacenter_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secret.id],
      name: 'tunnel_secret_id_secret_id_fk',
    }).onDelete('set null'),
    // Mirror TUNNEL_PROVIDERS / TUNNEL_PLACEMENTS / TUNNEL_STATUSES — pinned by enum-checks.test.ts.
    check('tunnel_provider_check', sql`provider IN ('cloudflare')`),
    check('tunnel_placement_check', sql`placement IN ('one', 'chosen', 'all')`),
    check('tunnel_status_check', sql`status IN ('pending', 'active', 'attention', 'removing')`),
  ]
)

/**
 * One server running one connector of a tunnel. Keyed by (tunnel, server)
 * only: no constraint ties the server to the tunnel's datacenter. For now the
 * code that adds a portal requires the server to be in that datacenter, so
 * the rule can be relaxed later without a migration.
 */
export const portal = pgTable(
  'portal',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    tunnelId: uuid('tunnel_id').notNull(),
    serverId: uuid('server_id').notNull(),
    wanted: text().default('running').notNull(),
    reported: text().default('unknown').notNull(),
    lastSeenAt: timestamp('last_seen_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }),
    lastError: text('last_error'),
  },
  (table) => [
    index('idx_portal_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    unique('uniq_portal_tunnel_id_server_id').on(table.tunnelId, table.serverId),
    foreignKey({
      columns: [table.tunnelId],
      foreignColumns: [tunnel.id],
      name: 'portal_tunnel_id_tunnel_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'portal_server_id_server_id_fk',
    }).onDelete('cascade'),
    // Mirror PORTAL_WANTED_STATES / PORTAL_REPORTED_STATES — pinned by enum-checks.test.ts.
    check('portal_wanted_check', sql`wanted IN ('running', 'stopped')`),
    check('portal_reported_check', sql`reported IN ('unknown', 'connected', 'down', 'error')`),
  ]
)

/**
 * One hostname a tunnel carries. `organization_id` repeats the tunnel's
 * organization so a name is unique per organization, the same rule `hostname`
 * applies with `routing_organization_id`. `hosting_id` is the site it serves
 * (kept when the site goes: the row is then unattached).
 */
export const doorway = pgTable(
  'doorway',
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
      .$onUpdate(() => sql`now()`)
      .notNull(),
    metadata: jsonb(),
    options: jsonb(),
    organizationId: uuid('organization_id').notNull(),
    tunnelId: uuid('tunnel_id').notNull(),
    hostname: text().notNull(),
    kind: text().default('http').notNull(),
    hostingId: uuid('hosting_id'),
    externalRouteId: text('external_route_id'),
    externalDnsRecordId: text('external_dns_record_id'),
    isLocalOnly: boolean('is_local_only').default(true).notNull(),
    status: text().default('pending').notNull(),
  },
  (table) => [
    index('idx_doorway_tunnel_id').using('btree', table.tunnelId.asc().nullsLast().op('uuid_ops')),
    index('idx_doorway_hosting_id').using(
      'btree',
      table.hostingId.asc().nullsLast().op('uuid_ops')
    ),
    unique('uniq_doorway_organization_id_hostname').on(table.organizationId, table.hostname),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'doorway_organization_id_organization_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tunnelId],
      foreignColumns: [tunnel.id],
      name: 'doorway_tunnel_id_tunnel_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.hostingId],
      foreignColumns: [hosting.id],
      name: 'doorway_hosting_id_hosting_id_fk',
    }).onDelete('set null'),
    // Mirror DOORWAY_KINDS / DOORWAY_STATUSES — pinned by enum-checks.test.ts.
    check('doorway_kind_check', sql`kind IN ('http')`),
    check('doorway_status_check', sql`status IN ('pending', 'live', 'attention', 'removing')`),
  ]
)
