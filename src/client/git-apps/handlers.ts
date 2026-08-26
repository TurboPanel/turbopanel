/**
 * The git-app CRUD handlers, shared by the admin and client surfaces.
 *
 * Both surfaces expose the same resource; they differ only in **scope** and in
 * how the caller was authorized to reach it:
 *
 * | | admin (`/api/admin/v1/git/apps`) | client (`/api/client/v1/git/apps`) |
 * | --- | --- | --- |
 * | Authorized by | `user.role` (admin/superadmin) | `organization:manage` on the org |
 * | Scope | instance-wide rows (`organization_id IS NULL`) | that organization's rows |
 * | Sees | instance-wide only | its own **plus** instance-wide |
 * | Writes | instance-wide only | its own only |
 *
 * That asymmetry — an organization reads instance-wide apps but cannot edit
 * them — is the whole point of the nullable scope column, so it is enforced
 * here once rather than in two routers. `scope.organizationId === null` is the
 * admin view throughout.
 */

import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { gitProviderApp } from '../../lib/db/schema.ts'
import {
  createGitApp,
  deleteGitApp,
  GitAppConflictError,
  GitAppError,
  generateWebhookRef,
  getGitAppSummary,
  listGitApps,
  updateGitApp,
  visibleGitAppsCondition,
} from '../../lib/git/git-app-records.ts'
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  githubAppCreateUrl,
  GithubManifestError,
} from '../../lib/git/github-manifest.ts'
import { githubApiBaseFor } from '../../lib/git/github-app-token.ts'
import {
  getPublicUrls,
  publicUrlEntryToInstallOrigin,
} from '../../admin/public-urls.ts'
import { webhookPathFor } from '../../lib/git/webhook-reachability.ts'
import {
  signGithubManifestState,
  verifyGithubManifestState,
} from '../sources/provider-install-state.ts'
import {
  GIT_APP_UUID_RE,
  parseGitAppCreateBody,
  parseGitAppPatchBody,
  serializeGitApp,
} from './routes-helpers.ts'
import { GITHUB_DEFAULT_BASE_URL } from '../../lib/git/git-app-records.ts'

export type GitAppScope = {
  /** `null` = the instance-wide (admin) view. */
  organizationId: string | null
}

/**
 * The origin to build webhook URLs from.
 *
 * The operator-managed public URL list, not the request origin: behind the
 * local Caddy → Unix socket the request origin is not an address any provider
 * can dial, so echoing it back would produce a URL that looks right and never
 * receives anything.
 */
async function resolvePublicOrigin(db: Db): Promise<string | null> {
  const origins = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .filter((origin): origin is string => origin !== null)
  return origins.find((origin) => origin.startsWith('https://')) ?? origins[0] ?? null
}

/**
 * Load one app the caller is allowed to *see*.
 *
 * Absence and invisibility answer the same 404: an organization has no business
 * learning that another organization registered an app.
 */
async function loadVisibleApp(
  db: Db,
  scope: GitAppScope,
  id: string,
): Promise<{ id: string; organizationId: string | null } | null> {
  const [row] = await db
    .select({
      id: gitProviderApp.id,
      organizationId: gitProviderApp.organizationId,
    })
    .from(gitProviderApp)
    .where(and(eq(gitProviderApp.id, id), visibleGitAppsCondition(scope.organizationId)))
    .limit(1)
  return row ?? null
}

/**
 * Visible *and* writable.
 *
 * An organization may read an instance-wide app but never edit it, so a
 * visible-but-not-owned row is a 403 rather than a 404 — the caller already
 * knows it exists.
 */
function assertWritable(
  c: Context<AppEnv>,
  scope: GitAppScope,
  row: { organizationId: string | null },
): Response | null {
  if (row.organizationId === scope.organizationId) return null
  return c.json({ error: 'git_app_not_writable' }, 403)
}

export async function listGitAppsHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
): Promise<Response> {
  const apps = await listGitApps(db, { organizationId: scope.organizationId })
  const publicOrigin = await resolvePublicOrigin(db)
  return c.json({
    apps: apps.map((app) =>
      serializeGitApp(app, { publicOrigin, viewerOrganizationId: scope.organizationId })
    ),
  })
}

export async function getGitAppHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
  id: string,
): Promise<Response> {
  if (!GIT_APP_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)
  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)

  const app = await getGitAppSummary(db, id)
  if (!app) return c.json({ error: 'Not found' }, 404)
  const publicOrigin = await resolvePublicOrigin(db)
  return c.json({
    app: serializeGitApp(app, {
      publicOrigin,
      viewerOrganizationId: scope.organizationId,
    }),
  })
}

export async function createGitAppHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
): Promise<Response> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const body = await c.req.json().catch(() => null)
  const input = parseGitAppCreateBody(body, scope.organizationId)
  if (!input) {
    return c.json({
      error:
        'expected { provider, name, externalAppId, baseUrl?, apiUrl?, appSlug?, ' +
        'clientId?, redirectUri?, privateKeyPem?, clientSecret?, webhookSecret? }',
    }, 400)
  }

  try {
    const app = await createGitApp(db, dataEncryptionSecrets, input)
    const publicOrigin = await resolvePublicOrigin(db)
    return c.json({
      app: serializeGitApp(app, {
        publicOrigin,
        viewerOrganizationId: scope.organizationId,
      }),
    }, 201)
  } catch (error) {
    if (error instanceof GitAppConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof GitAppError) return c.json({ error: error.message }, 400)
    throw error
  }
}

export async function patchGitAppHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
  id: string,
): Promise<Response> {
  if (!GIT_APP_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)
  const denied = assertWritable(c, scope, visible)
  if (denied) return denied

  const body = await c.req.json().catch(() => null)
  const updates = parseGitAppPatchBody(body)
  if (!updates) return c.json({ error: 'Invalid request' }, 400)

  try {
    const app = await updateGitApp(db, dataEncryptionSecrets, id, updates)
    if (!app) return c.json({ error: 'Not found' }, 404)
    const publicOrigin = await resolvePublicOrigin(db)
    return c.json({
      app: serializeGitApp(app, {
        publicOrigin,
        viewerOrganizationId: scope.organizationId,
      }),
    })
  } catch (error) {
    if (error instanceof GitAppConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof GitAppError) return c.json({ error: error.message }, 400)
    throw error
  }
}

export async function deleteGitAppHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
  id: string,
): Promise<Response> {
  if (!GIT_APP_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)
  const denied = assertWritable(c, scope, visible)
  if (denied) return denied

  // `installation` cascades from here, and `source.installation_id` is
  // ON DELETE SET NULL — so deleting an app disconnects its repositories
  // rather than destroying the operator's source rows.
  await deleteGitApp(db, id)
  return c.body(null, 204)
}

/**
 * Start the manifest flow.
 *
 * The `webhookRef` is minted here, before the App exists, so it can go into the
 * manifest's `hook_attributes.url` — the App is created already pointing at its
 * own scoped ingress. It travels to the callback inside the signed state, which
 * is the same envelope the install redirect uses, so a state minted for one
 * flow cannot be replayed into the other.
 *
 * The state carries the pending ref, origin, and name rather than a row id,
 * because the row does not exist yet — see `GithubManifestStateClaims`.
 */
export async function startGithubManifestHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
): Promise<Response> {
  const secretsConfig = c.get('secretsConfig')
  if (!secretsConfig) {
    return c.json({ error: 'Signing unavailable — no root secret configured' }, 503)
  }

  const publicOrigin = await resolvePublicOrigin(db)
  if (!publicOrigin) return c.json({ error: 'public_url_not_configured' }, 503)

  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; baseUrl?: unknown; organizationLogin?: unknown }
    | null
  const name = typeof body?.name === 'string' && body.name.trim().length > 0
    ? body.name.trim()
    : 'TurboPanel'
  const baseUrl = typeof body?.baseUrl === 'string' && body.baseUrl.trim().length > 0
    ? body.baseUrl.trim().replace(/\/+$/, '')
    : GITHUB_DEFAULT_BASE_URL
  const organizationLogin = typeof body?.organizationLogin === 'string' &&
      body.organizationLogin.trim().length > 0
    ? body.organizationLogin.trim()
    : null

  const webhookRef = generateWebhookRef()
  const origin = publicOrigin.replace(/\/$/, '')
  // GitHub sends the operator's *browser* to this URL, and a top-level
  // navigation carries no `X-Turbopanel-Organization-Id`. The org-scoped
  // surface therefore has to pin the organization in the query string, which
  // `parseOrgIdFromRequest` accepts as the header's equivalent. It is not a
  // credential — the session and the signed state are what authorize the
  // callback; this only says which org context to resolve it in.
  const callbackPath = scope.organizationId === null
    ? '/api/admin/v1/git/apps/github/manifest/callback'
    : `/api/client/v1/git/apps/github/manifest/callback?organizationId=${
      encodeURIComponent(scope.organizationId)
    }`

  const state = await signGithubManifestState(secretsConfig, {
    organizationId: scope.organizationId,
    webhookRef,
    baseUrl,
    name,
  })

  // The install redirect lands on the *source* callback — the one that writes
  // the `installation` row — and carries the same organization pin, since it is
  // also a top-level browser navigation.
  const setupPath = scope.organizationId === null
    ? '/api/client/v1/sources/github/callback'
    : `/api/client/v1/sources/github/callback?organizationId=${
      encodeURIComponent(scope.organizationId)
    }`

  return c.json({
    manifest: buildGithubAppManifest({
      name,
      publicUrl: origin,
      webhookUrl: `${origin}${webhookPathFor('github', webhookRef)}`,
      redirectUrl: `${origin}${callbackPath}`,
      setupUrl: `${origin}${setupPath}`,
    }),
    createUrl: githubAppCreateUrl(baseUrl, state, organizationLogin),
    state,
  })
}

/**
 * Finish the manifest flow: exchange the code and store the App.
 *
 * The row is written with the ref that was already baked into the App's webhook
 * URL, so the two agree from the first delivery onward.
 */
export async function completeGithubManifestHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: GitAppScope,
): Promise<Response> {
  const secretsConfig = c.get('secretsConfig')
  if (!secretsConfig) {
    return c.json({ error: 'Signing unavailable — no root secret configured' }, 503)
  }
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const state = c.req.query('state')
  const code = c.req.query('code')
  if (!state || !code) return c.json({ error: 'Invalid request' }, 400)

  const pending = await verifyGithubManifestState(secretsConfig, state)
  if (!pending) return c.json({ error: 'github_manifest_state_invalid' }, 400)
  // The signed state is the authority; the surface it came back on must agree.
  if (pending.organizationId !== scope.organizationId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  let conversion
  try {
    conversion = await convertGithubAppManifest(
      githubApiBaseFor({ apiUrl: null, baseUrl: pending.baseUrl }),
      code,
    )
  } catch (error) {
    if (error instanceof GithubManifestError) return c.json({ error: error.message }, 502)
    throw error
  }

  try {
    // The ref is written with the row, not corrected afterwards: GitHub's App
    // already points at that URL, so a row born with a different ref would
    // reject every delivery until someone noticed.
    const app = await createGitApp(db, dataEncryptionSecrets, {
      organizationId: scope.organizationId,
      provider: 'github',
      name: pending.name,
      baseUrl: pending.baseUrl,
      externalAppId: conversion.externalAppId,
      appSlug: conversion.appSlug,
      clientId: conversion.clientId,
      clientSecret: conversion.clientSecret,
      privateKeyPem: conversion.privateKeyPem,
      webhookSecret: conversion.webhookSecret,
      webhookRef: pending.webhookRef,
    })

    const publicOrigin = await resolvePublicOrigin(db)
    return c.json({
      app: serializeGitApp(app, {
        publicOrigin,
        viewerOrganizationId: scope.organizationId,
      }),
    }, 201)
  } catch (error) {
    if (error instanceof GitAppConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof GitAppError) return c.json({ error: error.message }, 400)
    throw error
  }
}
