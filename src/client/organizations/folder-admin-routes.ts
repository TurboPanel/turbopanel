/**
 * Folders that need a person, across the whole organization:
 *
 * - `GET /organizations/:id/folders` lists orphans (on a server with no
 *   service or volume that owns them), folders still being removed and folders
 *   the host no longer has, with the reason in plain words.
 * - `POST /folders/:id/remove` settles one: an orphan is removed from its
 *   server, a stuck removal is asked again now, a missing row is forgotten.
 *   A folder a service or volume is using is refused: delete that service or
 *   volume instead.
 *
 * Both need manage access to the organization. The list shares its rows with
 * the per-environment folder list.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { assertCanManageOr403 } from '../shared.ts'
import { getDb } from '../../db/connection.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { markOrphanFolderRemoving } from '../../features/folders/allocate.ts'
import {
  ATTENTION_FOLDER_STATES,
  type AttentionFolderState,
  folderOrganizationId,
  forgetMissingFolder,
  listOrganizationFolders,
  loadFolderForAction,
} from '../../features/folders/admin.ts'
import { enqueueFolderRemovals } from '../../features/folders/removal.ts'
import { isUuid } from '../../features/principals/store.ts'

export const FOLDER_IN_USE_ERROR = 'folder_in_use'

function parseStates(raw: string | undefined): AttentionFolderState[] | null {
  if (raw === undefined || raw === '') return []
  const states = raw.split(',').map((part) => part.trim())
  if (
    !states.every((s): s is AttentionFolderState => ATTENTION_FOLDER_STATES.includes(s as never))
  ) {
    return null
  }
  return [...new Set(states)] as AttentionFolderState[]
}

function parseCount(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  return /^\d{1,6}$/.test(raw) ? Number(raw) : null
}

export function registerOrganizationFolderAdminRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization folder routes')
  }
  router.use('/organizations/:id/folders', createSessionMiddleware(opts.secrets))
  router.use('/folders/:id/remove', createSessionMiddleware(opts.secrets))

  router.get('/organizations/:id/folders', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const organizationId = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const states = parseStates(c.req.query('state'))
    const limit = parseCount(c.req.query('limit'))
    const offset = parseCount(c.req.query('offset'))
    if (states === null || limit === null || offset === null) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const { folders, total } = await listOrganizationFolders(db, organizationId, {
      ...(states.length > 0 ? { states } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    })
    return c.json({ ok: true as const, folders, total })
  })

  router.post('/folders/:id/remove', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const folderId = c.req.param('id')
    if (!isUuid(folderId)) return c.json({ error: 'Not found' }, 404)
    const organizationId = await folderOrganizationId(db, folderId)
    if (!organizationId) return c.json({ error: 'Not found' }, 404)
    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const row = await loadFolderForAction(db, folderId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    if (row.state === 'planned' || row.state === 'present') {
      return c.json(
        {
          error: FOLDER_IN_USE_ERROR,
          message:
            'A service or volume is using this folder. Delete that service or volume to remove its folder.',
        },
        409
      )
    }

    if (row.state === 'orphan') {
      // Deleting the files of a leftover folder is permanent, like deleting a volume.
      const stepUp = await requireStepUpIfConfigured(c, organizationId, 'folder.remove')
      if (stepUp) return stepUp
    }

    let outcome: 'removing' | 'forgotten'
    if (row.state === 'missing') {
      if (!(await forgetMissingFolder(db, folderId))) return c.json({ error: 'Not found' }, 404)
      outcome = 'forgotten'
    } else {
      // An orphan starts its removal; a row already `removing` is asked again now.
      if (row.state === 'orphan') {
        const moved = await markOrphanFolderRemoving(db, folderId)
        if (moved === null) return c.json({ error: 'Not found' }, 404)
      }
      await enqueueFolderRemovals(
        db,
        c.get('commandQueue'),
        { actorType: 'user', actorId: session.userId },
        [row.serverId]
      )
      outcome = 'removing'
    }

    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email ?? null,
      action: 'folder.remove',
      targetType: 'organization',
      targetId: organizationId,
      context: {
        folderId,
        kind: row.kind,
        scope: row.scope,
        slug: row.slug,
        serverId: row.serverId,
        outcome,
      },
    })
    return c.json({ ok: true as const, outcome })
  })
}
