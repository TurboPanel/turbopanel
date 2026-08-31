import type { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { assertCanCreateOr403, getOrgId, parseJsonBody } from '../shared.ts'
import { parseDockerRunImportRequest } from './routes-helpers.ts'
import { composeDocumentToYaml } from '../../lib/compose/convert.ts'
import { lintComposeYaml } from '../../lib/compose/lint.ts'
import { validateComposeDocument } from '../../lib/compose/validate.ts'
import {
  type DockerRunDiagnostic,
  importDockerRunCommand,
} from '../../lib/docker-run/index.ts'

/**
 * `docker run` importer.
 *
 * Pure compute: it parses a command, compiles a compose fragment, and hands it
 * back, together with the `riskFlags` describing how the imported container's
 * blast radius widens — an output for the caller's own authorization and policy
 * gate, never an input that waives anything here. **It writes nothing.** Merging the fragment into a project or
 * environment draft and saving it goes through the ordinary compose PATCH
 * routes, which are where the write-boundary validation lives; duplicating a
 * save path here would mean two ways into `options.compose` with two sets of
 * rules.
 */
export function registerDockerRunRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for docker-run routes')
  }
  const secrets = opts.secrets

  router.use('/docker-run/import', createSessionMiddleware(secrets))

  router.post('/docker-run/import', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const request = parseDockerRunImportRequest(body)
    if (request === null) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    // A `projectId` is optional because the parse itself reads no org data. When
    // one is supplied the caller is asking about a specific project, so it is
    // resolved and gated at the same create-level bar as authoring compose for
    // that project would be.
    if (request.projectId !== null) {
      const projectOrgId = await resolveEntityOrganizationId(
        db,
        'project',
        request.projectId,
      )
      if (projectOrgId !== organizationId) {
        return c.json({ error: 'Not found' }, 404)
      }
      const denied = await assertCanCreateOr403(c, 'project', request.projectId)
      if (denied) return denied
    }

    const imported = importDockerRunCommand({
      serviceName: request.serviceName,
      argv: request.argv,
    })

    // A blocking diagnostic is not overridable. `--rm`, `-P`, the Windows-only
    // resource flags, an unknown option and a command with no image all mean
    // the fragment would no longer say what the operator pasted, and there is
    // no acknowledgement that makes a dropped flag into the right answer — the
    // command gets fixed, or it does not get imported.
    const blocking = imported.diagnostics.filter(
      (diagnostic: DockerRunDiagnostic) => diagnostic.blocking,
    )
    if (blocking.length > 0) {
      return c.json({
        error: 'docker_run_unsupported',
        diagnostics: imported.diagnostics,
      }, 422)
    }

    // Re-run the compose pipeline the fragment will hit on save, permissively.
    // The importer emits standard Compose vocabulary, so this should be quiet —
    // and when it is not, the operator is told here rather than at the PATCH
    // that rejects a draft they have already merged into.
    const validated = validateComposeDocument(imported.compose)
    const composeIssues = validated.ok
      ? lintComposeYaml(composeDocumentToYaml(imported.compose)).map((issue) => ({
        path: issue.path,
        message: issue.message,
        level: issue.level,
        ...(issue.line === undefined ? {} : { line: issue.line }),
      }))
      : validated.issues

    return c.json({
      ok: true as const,
      compose: imported.compose,
      image: imported.image,
      command: imported.command,
      diagnostics: imported.diagnostics,
      riskFlags: imported.riskFlags,
      composeIssues,
    })
  })
}
