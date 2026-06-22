/** Introspected from live dev DB (`./introspect.sh`). Review style before commit. */

import { sql } from 'drizzle-orm'
import { pgTable, index, foreignKey, uuid, timestamp, varchar, text, unique, check, jsonb, integer, boolean } from "drizzle-orm/pg-core"

export const invitation = pgTable("invitation", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	teamId: uuid("team_id"),
	email: varchar({ length: 255 }).notNull(),
	status: varchar({ length: 255 }).notNull(),
	/** Intended access grants materialized on accept — see `InvitationGrantSpec`. */
	grants: jsonb(),
}, (table) => [
	index("idx_invitation_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_invitation_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "invitation_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "invitation_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "invitation_team_id_team_id_fk"
		}).onDelete("cascade"),
]);
export const organization = pgTable("organization", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	slug: varchar({ length: 255 }),
	metadata: jsonb(),
	options: jsonb(),
}, (table) => [
	unique("organization_slug_unique").on(table.slug),
	check("organization_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const license = pgTable("license", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: uuid("organization_id").notNull(),
	displayName: varchar("display_name", { length: 255 }),
	/** PBKDF2-SHA256 hashed token — same format as account.password */
	hashedToken: text("hashed_token").notNull(),
	/** Soft-delete */
	revokedAt: timestamp("revoked_at", { precision: 3, withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_license_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "license_organization_id_organization_id_fk"
		}).onDelete("cascade"),
]);
export const passkey = pgTable("passkey", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow(),
	userId: uuid("user_id").notNull(),
	aaguid: text(),
	name: varchar({ length: 255 }),
	publicKey: text("public_key").notNull(),
	credentialId: varchar("credential_id", { length: 255 }).notNull(),
	counter: integer().default(0).notNull(),
	deviceType: varchar("device_type", { length: 32 }).notNull(),
	isBackedUp: boolean("is_backed_up").notNull(),
	transports: text(),
}, (table) => [
	index("idx_passkey_credential_id").using("btree", table.credentialId.asc().nullsLast().op("text_ops")),
	index("idx_passkey_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "passkey_user_id_user_id_fk"
		}).onDelete("cascade"),
]);
export const member = pgTable("member", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: uuid("organization_id").notNull(),
	userId: uuid("user_id").notNull(),
}, (table) => [
	index("idx_member_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "member_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "member_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("member_org_user_unique").on(table.organizationId, table.userId),
]);
export const server = pgTable("server", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { precision: 3, withTimezone: true, mode: 'string' }),
	organizationId: uuid("organization_id"),
	licenseId: uuid("license_id"),
	displayName: varchar("display_name", { length: 255 }),
	metadata: jsonb(),
	options: jsonb(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "server_organization_id_organization_id_fk"
		}),
	foreignKey({
			columns: [table.licenseId],
			foreignColumns: [license.id],
			name: "server_license_id_license_id_fk"
		}),
]);
export const workspace = pgTable("workspace", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	organizationId: uuid("organization_id").notNull(),
}, (table) => [
	unique("workspace_id_org_unique").on(table.id, table.organizationId),
	index("idx_workspace_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "workspace_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	check("workspace_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const environment = pgTable("environment", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	organizationId: uuid("organization_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
}, (table) => [
	unique("environment_id_org_unique").on(table.id, table.organizationId),
	index("idx_environment_workspace_id").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("idx_environment_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "environment_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspaceId, table.organizationId],
			foreignColumns: [workspace.id, workspace.organizationId],
			name: "environment_workspace_org_fk"
		}).onDelete("cascade"),
	check("environment_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const project = pgTable("project", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	organizationId: uuid("organization_id").notNull(),
	environmentId: uuid("environment_id").notNull(),
}, (table) => [
	unique("project_id_org_unique").on(table.id, table.organizationId),
	index("idx_project_environment_id").using("btree", table.environmentId.asc().nullsLast().op("uuid_ops")),
	index("idx_project_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "project_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.environmentId, table.organizationId],
			foreignColumns: [environment.id, environment.organizationId],
			name: "project_environment_org_fk"
		}).onDelete("cascade"),
	check("project_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const service = pgTable("service", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	organizationId: uuid("organization_id").notNull(),
	projectId: uuid("project_id").notNull(),
}, (table) => [
	unique("service_id_org_unique").on(table.id, table.organizationId),
	index("idx_service_project_id").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	index("idx_service_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "service_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
			name: "service_project_org_fk"
		}).onDelete("cascade"),
	check("service_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const hosting = pgTable("hosting", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	organizationId: uuid("organization_id").notNull(),
	projectId: uuid("project_id").notNull(),
}, (table) => [
	unique("hosting_id_org_unique").on(table.id, table.organizationId),
	index("idx_hosting_project_id").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	index("idx_hosting_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "hosting_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
			name: "hosting_project_org_fk"
		}).onDelete("cascade"),
	check("hosting_display_name_format_check", sql`(display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))`),
]);
export const grant = pgTable("grant", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	entityType: text("entity_type").notNull(),
	entityId: uuid("entity_id").notNull(),
	subjectType: text("subject_type").notNull(),
	subjectId: uuid("subject_id").notNull(),
	permission: text().notNull(),
	allowed: boolean().notNull().default(true),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("grant_unique").on(table.entityType, table.entityId, table.subjectType, table.subjectId, table.permission),
	index("idx_grant_entity").on(table.entityType, table.entityId),
	index("idx_grant_subject").on(table.subjectType, table.subjectId),
]);
export const session = pgTable("session", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: uuid("organization_id"),
	token: varchar({ length: 255 }).notNull(),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
}, (table) => [
	index("idx_session_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_session_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "session_organization_id_organization_id_fk"
		}).onDelete("set null"),
	unique("session_token_unique").on(table.token),
]);
export const setting = pgTable("setting", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	key: text().notNull(),
	value: text().notNull(),
}, (table) => [
	unique("setting_key_unique").on(table.key),
]);
export const account = pgTable("account", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userId: uuid("user_id").notNull(),
	providerId: text("provider_id").notNull(),
	providerUserId: text("provider_user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { precision: 3, withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { precision: 3, withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
}, (table) => [
	index("idx_account_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_user_id_fk"
		}).onDelete("cascade"),
]);
export const apikey = pgTable("apikey", {
	id: text().primaryKey().notNull(),
	configId: text("config_id").notNull(),
	name: text(),
	start: text(),
	prefix: text(),
	key: text().notNull(),
	referenceId: text("reference_id").notNull(),
	refillInterval: integer("refill_interval"),
	refillAmount: integer("refill_amount"),
	lastRefillAt: timestamp("last_refill_at", { precision: 6, withTimezone: true, mode: 'string' }),
	enabled: boolean(),
	rateLimitEnabled: boolean("rate_limit_enabled"),
	rateLimitTimeWindow: integer("rate_limit_time_window"),
	rateLimitMax: integer("rate_limit_max"),
	requestCount: integer("request_count"),
	remaining: integer(),
	lastRequest: timestamp("last_request", { precision: 6, withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { precision: 6, withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true, mode: 'string' }).notNull(),
	permissions: text(),
	metadata: text(),
}, (table) => [
	index("idx_apikey_config_id").using("btree", table.configId.asc().nullsLast().op("text_ops")),
	index("idx_apikey_reference_id").using("btree", table.referenceId.asc().nullsLast().op("text_ops")),
	index("idx_apikey_key").using("btree", table.key.asc().nullsLast().op("text_ops")),
]);
export const teammate = pgTable("teammate", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	teamId: uuid("team_id").notNull(),
	userId: uuid("user_id").notNull(),
}, (table) => [
	index("idx_teammate_team_id").using("btree", table.teamId.asc().nullsLast().op("uuid_ops")),
	index("idx_teammate_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "teammate_team_id_team_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "teammate_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("teammate_team_user_unique").on(table.teamId, table.userId),
]);
export const team = pgTable("team", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: uuid("organization_id").notNull(),
	displayName: varchar("display_name", { length: 255 }),
	metadata: jsonb(),
	options: jsonb(),
}, (table) => [
	index("idx_team_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "team_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	check("team_display_name_format_check", sql`(display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255))`),
]);
export const user = pgTable("user", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }),
	username: varchar({ length: 255 }),
	displayUsername: varchar("display_username", { length: 255 }),
	email: varchar({ length: 255 }).notNull(),
	isEmailVerified: boolean("is_email_verified").default(false).notNull(),
	is2FaEnabled: boolean("is_2fa_enabled").default(false).notNull(),
	isDisabled: boolean("is_disabled").default(false).notNull(),
	role: text().default('user').notNull(),
	metadata: jsonb(),
	options: jsonb(),
}, (table) => [
	unique("user_email_unique").on(table.email),
	unique("user_username_unique").on(table.username),
	check("user_display_name_format_check", sql`(display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255))`),
	check("user_username_format_check", sql`(username IS NULL) OR ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255))`),
	check("user_display_username_format_check", sql`(display_username IS NULL) OR ((char_length((display_username)::text) >= 1) AND (char_length((display_username)::text) <= 255))`),
]);
export const twoFactor = pgTable("2fa", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isVerified: boolean("is_verified").default(true),
	userId: uuid("user_id").notNull(),
	secret: varchar({ length: 255 }).notNull(),
	backupCodes: text("backup_codes").notNull(),
}, (table) => [
	index("idx_2fa_secret").using("btree", table.secret.asc().nullsLast().op("text_ops")),
	index("idx_2fa_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "2fa_user_id_user_id_fk"
		}).onDelete("cascade"),
]);
export const verification = pgTable("verification", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	identifier: varchar({ length: 255 }).notNull(),
	value: text().notNull(),
}, (table) => [
	index("idx_verification_identifier").using("btree", table.identifier.asc().nullsLast().op("text_ops")),
]);
