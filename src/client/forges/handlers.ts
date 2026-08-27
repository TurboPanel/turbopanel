/**
 * The forge CRUD handlers, shared by the admin and client surfaces.
 *
 * Both surfaces expose the same resource; they differ only in **scope** and in
 * how the caller was authorized to reach it:
 *
 * | | admin (`/api/admin/v1/forges`) | client (`/api/client/v1/forges`) |
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
import { forge } from '../../lib/db/schema.ts'
import {
  createForge,
  deleteForge,
  ForgeConflictError,
  ForgeError,
  generateWebhookRef,
  getForgeSummary,
  listForges,
  loadForge,
  updateForge,
  visibleForgesCondition,
} from '../../lib/git/forge-records.ts'
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  githubAppCreateUrl,
  GithubManifestError,
} from '../../lib/git/github-manifest.ts'
import { githubApiBaseFor } from '../../lib/git/github-app-token.ts'
import { fetchGithubAppMetadata } from '../../lib/git/github-app-metadata.ts'
import {
  getPublicUrls,
  publicUrlEntryToInstallOrigin,
} from '../../admin/public-urls.ts'
import { webhookPathFor } from '../../lib/git/webhook-reachability.ts'
import {
  signGithubManifestState,
  verifyGithubManifestState,
} from '../repositories/provider-install-state.ts'
import {
  FORGE_UUID_RE,
  parseForgeCreateBody,
  parseGithubManifestStartBody,
  parseForgePatchBody,
  serializeForge,
  githubManifestUiReturnPath,
  type GithubManifestReturnError,
} from './routes-helpers.ts'

export type ForgeScope = {
  /** `null` = the instance-wide (admin) view. */
  organizationId: string | null
}

/** Every origin this instance publishes, normalized for comparison. */
async function listPublicOrigins(db: Db): Promise<string[]> {
  return (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .filter((origin): origin is string => origin !== null)
    .map((origin) => origin.replace(/\/$/, ''))
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
  scope: ForgeScope,
  id: string,
): Promise<{ id: string; organizationId: string | null } | null> {
  const [row] = await db
    .select({
      id: forge.id,
      organizationId: forge.organizationId,
    })
    .from(forge)
    .where(and(eq(forge.id, id), visibleForgesCondition(scope.organizationId)))
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
  scope: ForgeScope,
  row: { organizationId: string | null },
): Response | null {
  if (row.organizationId === scope.organizationId) return null
  return c.json({ error: 'git_app_not_writable' }, 403)
}

export async function listForgesHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
): Promise<Response> {
  const apps = await listForges(db, { organizationId: scope.organizationId })
  const publicOrigin = await resolvePublicOrigin(db)
  return c.json({
    apps: apps.map((app) =>
      serializeForge(app, { publicOrigin, viewerOrganizationId: scope.organizationId })
    ),
  })
}

export async function getForgeHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
  id: string,
): Promise<Response> {
  if (!FORGE_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)
  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)

  const app = await getForgeSummary(db, id)
  if (!app) return c.json({ error: 'Not found' }, 404)
  const publicOrigin = await resolvePublicOrigin(db)
  return c.json({
    app: serializeForge(app, {
      publicOrigin,
      viewerOrganizationId: scope.organizationId,
    }),
  })
}

export async function createForgeHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
): Promise<Response> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const body = await c.req.json().catch(() => null)
  const input = parseForgeCreateBody(body, scope.organizationId)
  if (!input) {
    return c.json({
      error:
        'expected { provider, name, externalAppId, baseUrl?, apiUrl?, appSlug?, ' +
        'clientId?, redirectUri?, privateKeyPem?, clientSecret?, webhookSecret? }',
    }, 400)
  }

  try {
    const app = await createForge(db, dataEncryptionSecrets, input)
    const publicOrigin = await resolvePublicOrigin(db)
    return c.json({
      app: serializeForge(app, {
        publicOrigin,
        viewerOrganizationId: scope.organizationId,
      }),
    }, 201)
  } catch (error) {
    if (error instanceof ForgeConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof ForgeError) return c.json({ error: error.message }, 400)
    throw error
  }
}

export async function patchForgeHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
  id: string,
): Promise<Response> {
  if (!FORGE_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)
  const denied = assertWritable(c, scope, visible)
  if (denied) return denied

  const body = await c.req.json().catch(() => null)
  const updates = parseForgePatchBody(body)
  if (!updates) return c.json({ error: 'Invalid request' }, 400)

  try {
    const app = await updateForge(db, dataEncryptionSecrets, id, updates)
    if (!app) return c.json({ error: 'Not found' }, 404)
    const publicOrigin = await resolvePublicOrigin(db)
    return c.json({
      app: serializeForge(app, {
        publicOrigin,
        viewerOrganizationId: scope.organizationId,
      }),
    })
  } catch (error) {
    if (error instanceof ForgeConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof ForgeError) return c.json({ error: error.message }, 400)
    throw error
  }
}

export async function deleteForgeHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
  id: string,
): Promise<Response> {
  if (!FORGE_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)
  const denied = assertWritable(c, scope, visible)
  if (denied) return denied

  // `gitConnection` cascades from here, and `repository.connection_id` is
  // ON DELETE SET NULL — so deleting an app disconnects its repositories
  // rather than destroying the operator's repository rows.
  await deleteForge(db, id)
  return c.body(null, 204)
}

/**
 * Reconcile one app against the provider's own record of it.
 *
 * An operator can rename an App on GitHub, and nothing tells us — the App's
 * webhook vocabulary has no "I was renamed" event. The console would keep
 * showing the old name indefinitely, and a stale `app_slug` is worse than
 * cosmetic: it builds the install URL, so an App renamed on GitHub silently
 * loses the ability to connect new accounts.
 *
 * Writable apps only. An organization looking at an instance-wide app may read
 * it but must not rewrite fields the instance admin owns.
 */
export async function syncForgeHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
  id: string,
): Promise<Response> {
  if (!FORGE_UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable' }, 503)
  }

  const visible = await loadVisibleApp(db, scope, id)
  if (!visible) return c.json({ error: 'Not found' }, 404)
  const denied = assertWritable(c, scope, visible)
  if (denied) return denied

  const app = await loadForge(db, dataEncryptionSecrets, id)
  if (!app) return c.json({ error: 'Not found' }, 404)
  if (app.provider !== 'github') {
    // GitLab OAuth applications have no equivalent self-describing endpoint;
    // there is nothing to reconcile against.
    return c.json({ error: 'git_app_sync_unsupported' }, 400)
  }

  let metadata
  try {
    metadata = await fetchGithubAppMetadata(app)
  } catch (error) {
    // Always 502: every failure here is GitHub's answer to *our* App secrets,
    // not a fault in the operator's request. A 401 from GitHub means the stored
    // private key no longer matches the App — which is worth saying out loud in
    // `detail` rather than reflecting back as a 401 the console would read as
    // "your session expired".
    return c.json({
      error: 'git_app_sync_failed',
      detail: error instanceof Error ? error.message : 'unknown error',
    }, 502)
  }

  const updated = await updateForge(db, dataEncryptionSecrets, id, {
    name: metadata.name,
    appSlug: metadata.slug,
    externalAppId: metadata.externalAppId,
    // `null` means GitHub did not report visibility; keep what we recorded.
    ...(metadata.isPublic === null ? {} : { isPublic: metadata.isPublic }),
    syncedAt: new Date().toISOString(),
  })
  if (!updated) return c.json({ error: 'Not found' }, 404)

  const publicOrigin = await resolvePublicOrigin(db)
  return c.json({
    app: serializeForge(updated, {
      publicOrigin,
      viewerOrganizationId: scope.organizationId,
    }),
    // Reported rather than judged: what counts as drift is a product question,
    // and the console is where that comparison belongs.
    provider: { permissions: metadata.permissions, events: metadata.events },
  })
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
  scope: ForgeScope,
): Promise<Response> {
  const secretsConfig = c.get('secretsConfig')
  if (!secretsConfig) {
    return c.json({ error: 'Signing unavailable — no root secret configured' }, 503)
  }

  const publicOrigin = await resolvePublicOrigin(db)
  if (!publicOrigin) return c.json({ error: 'public_url_not_configured' }, 503)

  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  const wizard = parseGithubManifestStartBody(body)
  if (!wizard) return c.json({ error: 'invalid_manifest_request' }, 400)

  const { name, baseUrl, organizationLogin, apiUrl, pullRequestAccess } = wizard

  // The operator picks which published URL the App delivers to, because an
  // instance may have several and GitHub stores exactly one. It has to be one
  // this instance actually publishes — otherwise the App would be registered
  // against an address nothing here answers on. Falling back to the instance
  // default keeps the old single-URL behaviour working.
  let webhookOrigin = publicOrigin.replace(/\/$/, '')
  if (wizard.webhookOrigin) {
    const known = await listPublicOrigins(db)
    if (!known.includes(wizard.webhookOrigin)) {
      return c.json({ error: 'webhook_origin_not_published' }, 400)
    }
    webhookOrigin = wizard.webhookOrigin
  }

  // Instance-wide apps have to be installable by accounts other than the one
  // that created them; an organization's own app should not be.
  const isPublic = scope.organizationId === null

  const webhookRef = generateWebhookRef()
  const origin = publicOrigin.replace(/\/$/, '')
  // GitHub sends the operator's *browser* to this URL, and a top-level
  // navigation carries no `X-Turbopanel-Organization-Id`. The org-scoped
  // *manifest* callback still pins the organization in the query string,
  // which `parseOrgIdFromRequest` accepts as the header's equivalent. It is
  // not a secret — the session and the signed state are what authorize the
  // conversion; this only says which org context to resolve it in.
  const callbackPath = scope.organizationId === null
    ? '/api/admin/v1/forges/github/manifest/callback'
    : `/api/client/v1/forges/github/manifest/callback?organizationId=${
      encodeURIComponent(scope.organizationId)
    }`

  const state = await signGithubManifestState(secretsConfig, {
    organizationId: scope.organizationId,
    webhookRef,
    baseUrl,
    name,
    webhookOrigin,
    apiUrl,
    isPublic,
    pullRequestAccess,
    customGitUser: wizard.customGitUser,
    customGitPort: wizard.customGitPort,
  })

  // The install redirect lands on the *repository* callback — the one that
  // writes the `gitConnection` row. GitHub stores a single setup URL, so this
  // path stays org-neutral: the signed `state` carries organization and forge.
  const setupPath = '/api/client/v1/repositories/github/callback'

  const manifest = buildGithubAppManifest({
    name,
    publicUrl: origin,
    // The app's own origin, and the ref only when self-hosted — this URL is
    // what GitHub stores, and nothing revisits it.
    webhookUrl: `${webhookOrigin}${webhookPathFor('github', webhookRef, baseUrl)}`,
    redirectUrl: `${origin}${callbackPath}`,
    setupUrl: `${origin}${setupPath}`,
    publicApp: isPublic,
    pullRequestAccess,
  })
  return c.json({
    manifest,
    createUrl: githubAppCreateUrl(baseUrl, state, organizationLogin),
    state,
  })
}

function redirectToForgesUi(
  c: Context<AppEnv>,
  scope: ForgeScope,
  query: { created?: string; error?: GithubManifestReturnError },
): Response {
  const location = githubManifestUiReturnPath(scope.organizationId, query)
  return c.redirect(location, 302)
}

/**
 * Finish the manifest flow: exchange the code and store the App.
 *
 * GitHub sends the operator's *browser* here. After the row is written (or the
 * exchange fails), redirect to the Git providers page — a JSON 201 left the
 * browser sitting on the API path.
 *
 * The row is written with the ref that was already baked into the App's webhook
 * URL, so the two agree from the first delivery onward.
 */
export async function completeGithubManifestHandler(
  c: Context<AppEnv>,
  db: Db,
  scope: ForgeScope,
): Promise<Response> {
  const secretsConfig = c.get('secretsConfig')
  if (!secretsConfig) {
    return redirectToForgesUi(c, scope, { error: 'unavailable' })
  }
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return redirectToForgesUi(c, scope, { error: 'unavailable' })
  }

  const state = c.req.query('state')
  const code = c.req.query('code')
  if (!state || !code) {
    return redirectToForgesUi(c, scope, { error: 'invalid_request' })
  }

  const pending = await verifyGithubManifestState(secretsConfig, state)
  if (!pending) {
    return redirectToForgesUi(c, scope, { error: 'state_invalid' })
  }
  // The signed state is the authority; the surface it came back on must agree.
  if (pending.organizationId !== scope.organizationId) {
    return redirectToForgesUi(c, scope, { error: 'forbidden' })
  }

  let conversion
  try {
    conversion = await convertGithubAppManifest(
      githubApiBaseFor({ apiUrl: null, baseUrl: pending.baseUrl }),
      code,
    )
  } catch (error) {
    if (error instanceof GithubManifestError) {
      return redirectToForgesUi(c, scope, { error: 'conversion_failed' })
    }
    throw error
  }

  try {
    // The ref is written with the row, not corrected afterwards: GitHub's App
    // already points at that URL, so a row born with a different ref would
    // reject every delivery until someone noticed.
    const app = await createForge(db, dataEncryptionSecrets, {
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
      // GitHub's conversion response carries App secrets and nothing about how
      // the operator configured the app, so the rest comes back from the signed
      // state. Recording the origin matters most: GitHub stored one specific
      // URL and never revisits it, so this is the only way the console can show
      // the address deliveries actually arrive on.
      apiUrl: pending.apiUrl ?? null,
      webhookOrigin: pending.webhookOrigin ?? null,
      isPublic: pending.isPublic === true,
      customGitUser: pending.customGitUser ?? null,
      customGitPort: pending.customGitPort ?? null,
    })

    return redirectToForgesUi(c, scope, { created: app.id })
  } catch (error) {
    if (error instanceof ForgeConflictError) {
      return redirectToForgesUi(c, scope, { error: 'conflict' })
    }
    if (error instanceof ForgeError) {
      return redirectToForgesUi(c, scope, { error: 'create_failed' })
    }
    throw error
  }
}
