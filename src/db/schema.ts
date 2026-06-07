import { sql } from 'drizzle-orm'
import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata'),
  options: jsonb('options'),
}, (table) => [
  uniqueIndex('servers_metadata_machine_id_uidx')
    .on(sql`(${table.metadata}->>'machineId')`)
    .where(sql`${table.metadata}->>'machineId' is not null`),
  uniqueIndex('servers_metadata_hostname_uidx')
    .on(sql`(${table.metadata}->>'hostname')`)
    .where(sql`${table.metadata}->>'hostname' is not null`),
])
