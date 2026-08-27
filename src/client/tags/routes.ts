/**
 * Organization tag registry and entity tagging (`marker` join edges).
 *
 * Authz catalog is deliberately untouched: there are no per-tag grants.
 * Tag reads/writes gate on the organization (`assertCanReadOr403` /
 * `assertCanManageOr403` with kind `organization`). Marker writes gate on
 * the parent entity kind, which is already in the catalog, plus
 * `assertNotSystemOwnedOr403`. Registering `tag` / `marker` in
 * `RESOURCE_KINDS` / `ENTITY_TYPES` would force new branches in
 * `evaluator.ts`, `resolveEntityOrganizationId`, and
 * `resolveWorkspaceKindForEntity` for no behavioural gain.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import {
  TAG_NAME_IN_USE_ERROR,
  isTagDisplayNameTaken,
} from '../display-name-uniqueness.ts'
import { tag } from '../../lib/db/schema.ts'
import {
  createTag,
  deleteTag,
  isTagUniqueViolation,
  listMarkersForTag,
  listOrganizationTags,
  listTagsForEntity,
  serializeTag,
  setEntityTags,
  updateTag,
} from '../../lib/db/tag-records.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  buildTagPatchFields,
  hasTagParent,
  parseTagColor,
  parseTagDescription,
  parseTagIds,
  parseTagName,
  parseTagParent,
  invalidTagIdResponse,
  tagParentSourceFromQuery,
} from './routes-helpers.ts'

async function loadTagInOrganization(
  db: Db,
  id: string,
  organizationId: string,
) {
  const [row] = await db.select().from(tag).where(eq(tag.id, id)).limit(1)
  if (row?.organizationId !== organizationId) return null
  return row
}

async function assertTagIdsBelongToOrg(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  tagIds: readonly string[],
) {
  if (tagIds.length === 0) return null
  const rows = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.organizationId, organizationId), inArray(tag.id, [...tagIds])))
  if (rows.length !== tagIds.length) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

export function registerTagRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tag routes')
  }
  const secrets = opts.secrets

  router.use('/tags', createSessionMiddleware(secrets))
  router.use('/tags/:id', createSessionMiddleware(secrets))
  router.use('/markers', createSessionMiddleware(secrets))

  router.get('/tags', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const source = tagParentSourceFromQuery(c)
    if (!hasTagParent(source)) {
      const tags = await listOrganizationTags(db, organizationId)
      return c.json({ tags })
    }

    const parent = parseTagParent(c, source)
    if (parent instanceof Response) return parent

    const parentOrgId = await resolveEntityOrganizationId(db, parent.entityKind, parent.id)
    if (!parentOrgId || parentOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const entityDenied = await assertCanReadOr403(c, parent.entityKind, parent.id)
    if (entityDenied) return entityDenied

    const tags = await listTagsForEntity(db, parent.column, parent.id)
    return c.json({ tags })
  })

  router.get('/tags/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const invalidId = invalidTagIdResponse(c, id, 'path')
    if (invalidId) return invalidId
    const row = await loadTagInOrganization(db, id, organizationId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    return c.json({ tag: serializeTag(row) })
  })

  router.post('/tags', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const name = parseTagName(c, body.name)
    if (name instanceof Response) return name

    const description = parseTagDescription(c, body.description)
    if (description instanceof Response) return description

    const color = parseTagColor(c, body.color)
    if (color instanceof Response) return color

    if (await isTagDisplayNameTaken(db, organizationId, name)) {
      return c.json({ error: TAG_NAME_IN_USE_ERROR }, 409)
    }

    try {
      const id = await createTag(db, {
        organizationId,
        name,
        description: description ?? null,
        color: color ?? null,
      })
      return c.json({ ok: true, id })
    } catch (err) {
      if (isTagUniqueViolation(err)) {
        return c.json({ error: TAG_NAME_IN_USE_ERROR }, 409)
      }
      throw err
    }
  })

  router.patch('/tags/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const invalidId = invalidTagIdResponse(c, id, 'path')
    if (invalidId) return invalidId
    const row = await loadTagInOrganization(db, id, organizationId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const updateFields = buildTagPatchFields(c, body)
    if (updateFields instanceof Response) return updateFields

    if (updateFields.name !== undefined) {
      if (await isTagDisplayNameTaken(db, organizationId, updateFields.name, id)) {
        return c.json({ error: TAG_NAME_IN_USE_ERROR }, 409)
      }
    }

    try {
      await updateTag(db, id, updateFields)
      return c.json({ ok: true })
    } catch (err) {
      if (isTagUniqueViolation(err)) {
        return c.json({ error: TAG_NAME_IN_USE_ERROR }, 409)
      }
      throw err
    }
  })

  router.delete('/tags/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const invalidId = invalidTagIdResponse(c, id, 'path')
    if (invalidId) return invalidId
    const row = await loadTagInOrganization(db, id, organizationId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    await deleteTag(db, id)
    return c.json({ ok: true })
  })

  router.get('/markers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const tagId = c.req.query('tagId')
    if (!tagId) return c.json({ error: 'Invalid request' }, 400)
    const invalidTagId = invalidTagIdResponse(c, tagId, 'query')
    if (invalidTagId) return invalidTagId

    const row = await loadTagInOrganization(db, tagId, organizationId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const markers = await listMarkersForTag(db, tagId)
    return c.json({ markers })
  })

  router.put('/markers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parent = parseTagParent(c, body)
    if (parent instanceof Response) return parent

    const tagIds = parseTagIds(c, body.tagIds)
    if (tagIds instanceof Response) return tagIds

    const parentOrgId = await resolveEntityOrganizationId(db, parent.entityKind, parent.id)
    if (!parentOrgId || parentOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, parent.entityKind, parent.id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, parent.entityKind, parent.id)
    if (immutable) return immutable

    const missing = await assertTagIdsBelongToOrg(c, db, organizationId, tagIds)
    if (missing) return missing

    const tags = await setEntityTags(db, parent.column, parent.id, tagIds)
    return c.json({ ok: true, tags })
  })
}
