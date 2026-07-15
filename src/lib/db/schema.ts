/** Introspected from live dev DB (`dev/scripts/introspect.sh`). Review style before commit. */

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
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    userId: uuid('user_id').notNull(),
    teamId: uuid('team_id').notNull(),
    email: varchar({ length: 255 }).notNull(),
    status: varchar({ length: 255 }).notNull(),
    /** Intended access grants materialized on accept — see `InvitationGrantSpec`. */
    grants: jsonb(),
  },
  (table) => [
    index('idx_invitation_email').using('btree', table.email.asc().nullsLast().op('text_ops')),
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
    displayName: varchar('display_name', { length: 255 }),
    /** PBKDF2-SHA256 hashed token — same format as account.password */
    token: text().notNull(),
    /** Soft-delete */
    revokedAt: timestamp('revoked_at', { precision: 3, withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_license_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'license_organization_id_organization_id_fk',
    }).onDelete('cascade'),
  ]
)
/**
 * Organization TLS certificate library (upload / Let's Encrypt / self-signed).
 * Private keys are sealed `tpsecret` envelopes — never returned on client GET.
 * Hosting pins via `hosting.tls_id`; deploy auto-matches by SAN when unset.
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
    metadata: jsonb().notNull(),
    options: jsonb(),
  },
  (table) => [
    index('idx_tls_organization_id').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops')
    ),
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
    }).defaultNow(),
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
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    organizationId: uuid('organization_id'),
    licenseId: uuid('license_id'),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb(),
    options: jsonb(),
    daemon: jsonb('daemon'),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'server_organization_id_organization_id_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.licenseId],
      foreignColumns: [license.id],
      name: 'server_license_id_license_id_fk',
    }).onDelete('restrict'),
  ]
)
// Lifecycle timestamps live in metadata; nowIso() ISO-UTC strings sort lexicographically.
export const command = pgTable(
  'command',
  {
    id: uuid()
      .default(sql`uuidv7()`)
      .primaryKey()
      .notNull(),
    serverId: uuid('server_id').notNull(),
    actorEntityType: text('actor_entity_type').notNull(),
    actorEntityId: uuid('actor_entity_id').notNull(),
    name: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().default(0).notNull(),
    metadata: jsonb().notNull(),
    payload: jsonb().notNull(),
    result: jsonb(),
  },
  (table) => [
    index('idx_command_server_id_created_at').using(
      'btree',
      table.serverId.asc(),
      sql`(${table.metadata}->>'createdAt') desc`
    ),
    index('idx_command_status').using('btree', table.status.asc()),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'command_server_id_server_id_fk',
    }).onDelete('cascade'),
  ]
)
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
    serverId: uuid('server_id').notNull(),
  },
  (table) => [
    index('idx_network_server_id').using('btree', table.serverId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.serverId],
      foreignColumns: [server.id],
      name: 'network_server_id_server_id_fk',
    }).onDelete('restrict'),
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
    unique('workspace_id_org_unique').on(table.id, table.organizationId),
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
    updatedAt: timestamp('updated_at', { precision: 3, withTimezone: true, mode: 'string' }),
    projectId: uuid('project_id').notNull(),
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_managed_project_id').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops')
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'managed_project_id_project_id_fk',
    }).onDelete('cascade'),
    unique('managed_project_id_unique').on(table.projectId),
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
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: 'environment_project_id_project_id_fk',
    }).onDelete('restrict'),
    check(
      'environment_display_name_format_check',
      sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`
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
    metadata: jsonb(),
    options: jsonb(),
  },
  (table) => [
    index('idx_service_environment_id').using(
      'btree',
      table.environmentId.asc().nullsLast().op('uuid_ops')
    ),
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
    /** Optional pin into the org TLS library; null = auto-match by SAN. */
    tlsId: uuid('tls_id'),
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
    expiresAt: timestamp('expires_at', {
      precision: 3,
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    userId: uuid('user_id').notNull(),
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
    index('idx_2fa_secret').using('btree', table.secret.asc().nullsLast().op('text_ops')),
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
    index('idx_verification_identifier').using(
      'btree',
      table.identifier.asc().nullsLast().op('text_ops')
    ),
  ]
)
