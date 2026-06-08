import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { ServerMetadata } from './server-metadata.ts'

/** When true in the settings table, self-service signup is allowed (value '1' / '0'). */
export const IS_SIGNUP_ENABLED_CONFIG_KEY = 'IS_SIGNUP_ENABLED'

const ts = {
  precision: 3 as const,
  withTimezone: true,
  mode: 'date' as const,
}

export const user = pgTable('user', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
  name: varchar('display_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  image: text('image'),
  isEmailVerified: boolean('is_email_verified').notNull().default(false),
  isTwoFactorEnabled: boolean('is_2fa_enabled').notNull().default(false),
  isDisabled: boolean('is_disabled').notNull().default(false),
  metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
})

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', ts),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', ts),
    scope: text('scope'),
    password: text('password'),
  },
  (table) => [index('idx_account_user_id').on(table.userId)],
)

export const organization = pgTable(
  'organization',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    logo: text('logo'),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
  },
  () => [
    check(
      'organization_display_name_format_check',
      sql`char_length("display_name") BETWEEN 1 AND 255 AND "display_name" ~ '^[A-Za-z0-9 ._-]+$'`,
    ),
  ],
)

export const member = pgTable(
  'member',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    organizationId: uuid('organization_id').notNull().references(() => organization.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (table) => [
    index('idx_member_user_id').on(table.userId),
    index('idx_member_organization_id').on(table.organizationId),
  ],
)

export const team = pgTable(
  'team',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
    organizationId: uuid('organization_id').notNull().references(() => organization.id, {
      onDelete: 'cascade',
    }),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index('idx_team_organization_id').on(table.organizationId),
    check('team_display_name_format_check', sql`char_length("display_name") BETWEEN 1 AND 255`),
  ],
)

export const teamMember = pgTable(
  'team_member',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    teamId: uuid('team_id').notNull().references(() => team.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_team_member_team_id').on(table.teamId),
    index('idx_team_member_user_id').on(table.userId),
  ],
)

export const invitation = pgTable(
  'invitation',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', ts).notNull(),
    inviterUserId: uuid('inviter_user_id').notNull().references(() => user.id, {
      onDelete: 'cascade',
    }),
    organizationId: uuid('organization_id').notNull().references(() => organization.id, {
      onDelete: 'cascade',
    }),
    teamId: uuid('team_id').references(() => team.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: text('role'),
    status: varchar('status', { length: 255 }).notNull(),
  },
  (table) => [
    index('idx_invitation_organization_id').on(table.organizationId),
    index('idx_invitation_email').on(table.email),
  ],
)

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
    expiresAt: timestamp('expires_at', ts).notNull(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: uuid('active_organization_id')
      .references(() => organization.id, { onDelete: 'set null' })
      .default(sql`null`),
    activeOrganizationTeamId: uuid('active_organization_team_id')
      .references(() => team.id, { onDelete: 'set null' })
      .default(sql`null`),
    token: varchar('token', { length: 255 }).notNull().unique(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (table) => [index('idx_session_user_id').on(table.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
    expiresAt: timestamp('expires_at', ts).notNull(),
    identifier: varchar('identifier', { length: 255 }).notNull(),
    value: text('value').notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)],
)

/** better-auth two-factor (TOTP / backup codes). Table name must be `2fa` for a future adapter. */
export const twoFactor = pgTable(
  '2fa',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    verified: boolean('is_verified').default(true),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    secret: varchar('secret', { length: 255 }).notNull(),
    backupCodes: text('backup_codes').notNull(),
  },
  (table) => [
    index('idx_2fa_user_id').on(table.userId),
    index('idx_2fa_secret').on(table.secret),
  ],
)

export const passkey = pgTable(
  'passkey',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).defaultNow(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    aaguid: text('aaguid'),
    name: varchar('name', { length: 255 }),
    publicKey: text('public_key').notNull(),
    credentialId: varchar('credential_id', { length: 255 }).notNull(),
    counter: integer('counter').notNull().default(0),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    backedUp: boolean('is_backed_up').notNull(),
    transports: text('transports'),
  },
  (table) => [
    index('idx_passkey_user_id').on(table.userId),
    index('idx_passkey_credential_id').on(table.credentialId),
  ],
)

export const setting = pgTable('setting', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', ts).notNull().defaultNow().$onUpdate(() => new Date()),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
})

export const rateLimit = pgTable('rate_limit', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  // Unix epoch ms; exceeds INT4 range so must remain a 64-bit integer.
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
})

export const server = pgTable(
  'server',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', ts).notNull(),
    updatedAt: timestamp('updated_at', ts).notNull(),
    deletedAt: timestamp('deleted_at', ts),
    organizationId: uuid('organization_id').references(() => organization.id),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    metadata: jsonb('metadata').$type<ServerMetadata | null>(),
  },
  () => [
    check('server_display_name_format_check', sql`char_length("display_name") BETWEEN 1 AND 255`),
  ],
)

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}))

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [invitation.inviterUserId], references: [user.id] }),
  team: one(team, { fields: [invitation.teamId], references: [team.id] }),
}))

export const organizationMemberRelations = relations(member, ({ one }) => ({
  user: one(user, { fields: [member.userId], references: [user.id] }),
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
}))

export const organizationRelations = relations(organization, ({ many }) => ({
  invitations: many(invitation),
  members: many(member),
  sessions: many(session),
  teams: many(team),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
  organization: one(organization, {
    fields: [session.activeOrganizationId],
    references: [organization.id],
  }),
  team: one(team, { fields: [session.activeOrganizationTeamId], references: [team.id] }),
}))

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
  team: one(team, { fields: [teamMember.teamId], references: [team.id] }),
  user: one(user, { fields: [teamMember.userId], references: [user.id] }),
}))

export const teamRelations = relations(team, ({ one, many }) => ({
  organization: one(organization, {
    fields: [team.organizationId],
    references: [organization.id],
  }),
  invitations: many(invitation),
  sessions: many(session),
  teamMembers: many(teamMember),
}))

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}))

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, { fields: [passkey.userId], references: [user.id] }),
}))

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  invitations: many(invitation),
  members: many(member),
  passkeys: many(passkey),
  sessions: many(session),
  teamMembers: many(teamMember),
  twoFactors: many(twoFactor),
}))
