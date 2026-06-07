import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/** Placeholder table — replace with real schema as features land. */
export const healthChecks = pgTable('health_checks', {
  id: serial('id').primaryKey(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})
