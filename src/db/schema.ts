/** Introspected from live dev DB (`./introspect.sh`). Review style before commit. */

import { sql } from 'drizzle-orm'
import { pgTable, index, foreignKey, uuid, timestamp, varchar, text, unique, check, jsonb, integer, boolean } from "drizzle-orm/pg-core"
export const invitation = pgTable("invitation", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	inviterUserId: uuid("inviter_user_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	teamId: uuid("team_id"),
	email: varchar({ length: 255 }).notNull(),
	role: text(),
	status: varchar({ length: 255 }).notNull(),
}, (table) => [
	index("idx_invitation_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_invitation_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.inviterUserId],
			foreignColumns: [user.id],
			name: "invitation_inviter_user_id_user_id_fk"
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
	displayName: varchar("display_name", { length: 255 }).notNull(),
	slug: varchar({ length: 255 }).notNull(),
	logo: text(),
	metadata: jsonb(),
}, (table) => [
	unique("organization_slug_unique").on(table.slug),
	check("organization_display_name_format_check", sql`((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)`),
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
	role: text().notNull(),
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
]);
export const server = pgTable("server", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { precision: 3, withTimezone: true, mode: 'string' }),
	organizationId: uuid("organization_id"),
	displayName: varchar("display_name", { length: 255 }),
	metadata: jsonb(),
	options: jsonb(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "server_organization_id_organization_id_fk"
		}),
]);
export const session = pgTable("session", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true, mode: 'string' }).notNull(),
	userId: uuid("user_id").notNull(),
	token: varchar({ length: 255 }).notNull(),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
}, (table) => [
	index("idx_session_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_user_id_fk"
		}).onDelete("cascade"),
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
export const mate = pgTable("mate", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	teamId: uuid("team_id").notNull(),
	userId: uuid("user_id").notNull(),
}, (table) => [
	index("idx_mate_team_id").using("btree", table.teamId.asc().nullsLast().op("uuid_ops")),
	index("idx_mate_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.teamId],
			foreignColumns: [team.id],
			name: "team_member_team_id_team_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "team_member_user_id_user_id_fk"
		}).onDelete("cascade"),
]);
export const team = pgTable("team", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: uuid("organization_id").notNull(),
	displayName: varchar("display_name", { length: 255 }).notNull(),
	metadata: jsonb(),
}, (table) => [
	index("idx_team_organization_id").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "team_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	check("team_display_name_format_check", sql`(char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)`),
]);
export const user = pgTable("user", {
	id: uuid().default(sql`uuidv7()`).primaryKey().notNull(),
	createdAt: timestamp("created_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	displayName: varchar("display_name", { length: 255 }).notNull(),
	username: varchar({ length: 255 }).notNull(),
	displayUsername: varchar("display_username", { length: 255 }).notNull(),
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
