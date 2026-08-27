/**
 * Git-backed **release** reads and the rollback trigger for one environment.
 *
 * Releases are read from the append-only `command` history via
 * `lib/db/releases.ts` — see that module for why a release is not a deploy and
 * cannot be answered by `deployment` or by deploy-history grouping, and why a
 * multi-server fan-out reads back as one environment-scoped release rather than
 * one row per host.
 *
 * A release is only offered as a rollback target when it is materialized for
 * the **whole** deploy target set: the same id is dispatched to every server the
 * environment currently deploys to, so a release that succeeded on only some of
 * them (or was published before the environment gained a server) would fail the
 * daemon's missing-release check on the rest — after its peers had already cut
 * over.
 *
 * Rollback deliberately does **not** get its own command type or its own
 * enqueue path. It calls the same `runEnvironmentDeployForActor` the deploy
 * route and the GitHub webhook trigger use, with one extra field on the auth
 * object; that is where `environment.generation` is bumped, and the daemon's
 * newer-generation supersede rule only protects commands that went through it.
 * All the field changes is which `sourceMaterial[]` the prepare layer produces.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { getDb } from '../../db.ts'
import { assertCanReadOr403, parseJsonBody } from '../shared.ts'
import {
  isReleaseMaterializedEverywhere,
  listServiceReleases,
  SERVICE_RELEASES_MAX_LIMIT,
  type ServiceReleaseRecord,
} from '../../lib/db/releases.ts'
import { listEnvironmentDeploymentTargets } from '../../lib/db/deployment-records.ts'
import type { DeployRollbackReleasePin } from './deploy-sources.ts'
import {
  assertDeployDispatchInfrastructure,
  authorizeEnvironmentManage,
  runEnvironmentDeployForActor,
} from './deploy-routes.ts'

/** Mirrors `SOURCE_RELEASE_ID_RE` on both wire contracts. */
const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/

/** Compose service keys are already constrained by the compose lint; re-check the shape. */
const COMPOSE_SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** `null` for an unusable value; `undefined` for "not supplied". */
export function parseLimit(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SERVICE_RELEASES_MAX_LIMIT) {
    return null
  }
  return parsed
}

type RollbackBody = { composeServiceName: string; releaseId: string }

/** The commit metadata a pinned release already recorded, carried forward. */
export function releasePin(release: ServiceReleaseRecord): DeployRollbackReleasePin {
  return {
    releaseId: release.releaseId,
    // A rollback resolves no ref, so what the new release row records has to
    // come from the pinned release's own history — otherwise it would persist
    // the branch name as the commit. Absent on releases published before this
    // metadata was recorded, and the prepare layer falls back to the ref then.
    commitSha: release.commitSha,
    ...(release.commitMessage === undefined
      ? {}
      : { commitMessage: release.commitMessage }),
    ...(release.commitAuthor === undefined
      ? {}
      : { commitAuthor: release.commitAuthor }),
  }
}

/**
 * Every Git-backed service pinned to the release it must end up on: the target
 * for the service being rolled back, and each other service's *current live*
 * release.
 *
 * Pinning the others is what keeps the deploy payload a complete statement of
 * the environment's releases. `sourceMaterial[]` is also how the host decides
 * which release trees are still in use, which document root each site serves
 * from, and what `deployment.json` records — a one-entry payload would read as
 * "every other service lost its source" and reclaim their trees. Re-promoting a
 * service onto the release it already runs is an idempotent symlink swap with
 * no build, so pinning costs nothing. Services with no succeeded release yet
 * are absent: they have no tree to protect and nothing to promote.
 *
 * `targetServerIds` narrows that further, and for the same reason the rollback
 * target itself is coverage-checked: the pinned id is dispatched to *every*
 * server, so a live release that never reached one of them would fail that
 * host's promote. Such a service is left unpinned — the deploy then builds it
 * fresh from its compose binding, which every host can do — rather than pinned
 * to an id a host has never seen.
 */
export function releaseByService(
  releases: readonly ServiceReleaseRecord[],
  target: ServiceReleaseRecord,
  targetServerIds: ReadonlySet<string>
): Record<string, DeployRollbackReleasePin> {
  const pinned: Record<string, DeployRollbackReleasePin> = {}
  for (const release of releases) {
    if (!release.isLive) continue
    if (!isReleaseMaterializedEverywhere(release, targetServerIds)) continue
    pinned[release.composeServiceName] = releasePin(release)
  }
  pinned[target.composeServiceName] = releasePin(target)
  return pinned
}

export function parseRollbackBody(body: Record<string, unknown>): RollbackBody | null {
  const composeServiceName = body.composeServiceName
  const releaseId = body.releaseId
  if (typeof composeServiceName !== 'string' || !COMPOSE_SERVICE_NAME_RE.test(composeServiceName)) {
    return null
  }
  if (typeof releaseId !== 'string' || !RELEASE_ID_RE.test(releaseId)) return null
  return { composeServiceName, releaseId }
}

/**
 * `GET /environments/:id/releases` — every Git-backed release this environment
 * has published, newest first, optionally narrowed to one compose service.
 *
 * `POST /environments/:id/rollback` — re-promote one already-published release.
 */
export function registerEnvironmentReleaseRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment release routes')
  }
  router.use('/environments/:id/releases', createSessionMiddleware(opts.secrets))
  router.use('/environments/:id/rollback', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/releases', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const limit = parseLimit(c.req.query('limit'))
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${SERVICE_RELEASES_MAX_LIMIT}` },
        400
      )
    }

    const composeServiceName = c.req.query('composeServiceName')
    if (composeServiceName !== undefined && !COMPOSE_SERVICE_NAME_RE.test(composeServiceName)) {
      return c.json({ error: 'Invalid composeServiceName' }, 400)
    }

    const releases = await listServiceReleases(db, environmentId, {
      ...(composeServiceName === undefined ? {} : { composeServiceName }),
      ...(limit === undefined ? {} : { limit }),
    })

    return c.json({ ok: true as const, releases })
  })

  router.post('/environments/:id/rollback', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    // Rolling a service back changes what is running: the manage gate, not read.
    const auth = await authorizeEnvironmentManage(c, db, environmentId)
    if (auth instanceof Response) return auth

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const parsed = parseRollbackBody(body)
    if (!parsed) return c.json({ error: 'Invalid request' }, 400)

    const releases = await listServiceReleases(db, environmentId, {
      limit: SERVICE_RELEASES_MAX_LIMIT,
    })

    // Only a release this environment actually built, and actually finished
    // building, may be a target. Without this an operator could name any id and
    // the deploy would fail halfway through on a directory the host never had.
    // `status` here is already the environment-wide aggregate — a release that
    // failed on any one of its hosts is not `succeeded`.
    const target = releases.find(
      (release) =>
        release.composeServiceName === parsed.composeServiceName &&
        release.releaseId === parsed.releaseId &&
        release.status === 'succeeded'
    )
    if (!target) {
      return c.json(
        {
          error: 'release_not_found',
          message: 'No succeeded release with that id exists for this service in this environment.',
          composeServiceName: parsed.composeServiceName,
          releaseId: parsed.releaseId,
        },
        404
      )
    }

    // Environment-wide, not just "did it succeed once": the rollback dispatches
    // this one id to every server the environment currently deploys to, and any
    // host that never published it fails the daemon's missing-release check
    // after its peers have already cut over. A release from before the
    // environment gained a server is therefore not a rollback target.
    const targetServerIds = new Set(
      (await listEnvironmentDeploymentTargets(db, environmentId)).map((row) => row.serverId)
    )
    if (!isReleaseMaterializedEverywhere(target, targetServerIds)) {
      return c.json(
        {
          error: 'release_not_materialized',
          message:
            'That release was not published on every server this environment deploys to, so it cannot be rolled back to.',
          composeServiceName: parsed.composeServiceName,
          releaseId: parsed.releaseId,
        },
        409
      )
    }

    const commandQueue = assertDeployDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    return await runEnvironmentDeployForActor(c, db, commandQueue, environmentId, {
      actorType: 'user',
      actorId: auth.userId,
      organizationId: auth.organizationId,
      // A rollback promotes trees that already passed their health probe once,
      // and it never rebuilds, so neither deploy flag has anything to act on.
      acknowledgeHealthCheckWarnings: true,
      noCache: false,
      selection: { ref: null, commitSha: null, sourceId: null },
      rollback: {
        composeServiceName: parsed.composeServiceName,
        releaseByService: releaseByService(releases, target, targetServerIds),
      },
    })
  })
}
