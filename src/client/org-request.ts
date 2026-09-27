/**
 * The preamble every organization-scoped client route opens with — database,
 * session, then the request's organization — as one call, so each handler
 * keeps only what is specific to it.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { type Db, getDb } from '../db/connection.ts'
import type { SessionData } from './authn/session-store.ts'
import { getOrgId } from './shared.ts'

export type OrgRequest = {
  db: Db
  session: SessionData
  organizationId: string
}

/**
 * `503 Database unavailable` without a database, `401 Unauthorized` without a
 * session, the organization resolver's own refusal when the request names no
 * organization the user belongs to — in that order, exactly as the handlers
 * wrote it inline.
 */
export async function resolveOrgRequest(c: Context<AppEnv>): Promise<OrgRequest | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const organizationId = await getOrgId(c, session.userId)
  if (organizationId instanceof Response) return organizationId

  return { db, session, organizationId }
}
