/**
 * Pure parsing and serialization for the git-app CRUD surfaces.
 *
 * Two routers mount this logic — the admin one for instance-wide apps and the
 * client one for organization-owned apps — and the only thing that differs
 * between them is the scope they write into and who is allowed to. Keeping the
 * body grammar here means the two cannot drift into accepting different shapes
 * for the same resource.
 *
 * **Partial updates keep sealed material.** An omitted secret field leaves the
 * stored envelope alone; an explicit `null` clears it. That is what lets a
 * settings form save a name change without the operator re-pasting a private
 * key it was never shown.
 */

import {
  type GitAppCreate,
  type GitAppProvider,
  type GitAppSummary,
  type GitAppUpdate,
  GIT_APP_PROVIDERS,
} from '../../lib/git/git-app-records.ts'
import {
  webhookPathFor,
  type WebhookProvider,
} from '../../lib/git/webhook-reachability.ts'

export const GIT_APP_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Plain fields that accept a value or an explicit `null` to clear. */
const NULLABLE_TEXT_FIELDS = ['apiUrl', 'appSlug', 'clientId', 'redirectUri'] as const

/** Sealed fields; same nullable grammar, never echoed back. */
const SECRET_FIELDS = ['privateKeyPem', 'clientSecret', 'webhookSecret'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Apply the nullable-field grammar to one key.
 *
 * Three states, and the distinction matters: **absent** keeps the stored value,
 * an explicit **null** clears it, and a **string** replaces it. An empty string
 * is none of those and is rejected rather than folded into "clear" — otherwise
 * a form that submitted a blank private-key box would silently wipe a key the
 * operator was never shown, which is exactly the accident the write-only fields
 * exist to prevent. Clearing is available, but you have to mean it.
 *
 * Returns `false` on a type error so the caller can reject the whole body
 * rather than silently dropping a field the operator meant to set.
 */
function applyNullable(
  raw: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): boolean {
  if (!(key in raw)) return true
  const value = raw[key]
  if (value === null) {
    target[key] = null
    return true
  }
  if (typeof value !== 'string') return false
  if (value.trim().length === 0) return false
  target[key] = value
  return true
}

export function parseGitAppCreateBody(
  body: unknown,
  organizationId: string | null,
): GitAppCreate | null {
  if (!isPlainObject(body)) return null

  const provider = readRequiredString(body.provider)
  if (!provider || !GIT_APP_PROVIDERS.includes(provider as GitAppProvider)) return null

  const name = readRequiredString(body.name)
  if (!name) return null

  const externalAppId = readRequiredString(body.externalAppId)
  if (!externalAppId) return null

  const parsed: Record<string, unknown> = {
    organizationId,
    provider: provider as GitAppProvider,
    name,
    externalAppId,
  }

  if ('baseUrl' in body) {
    const baseUrl = readRequiredString(body.baseUrl)
    if (!baseUrl) return null
    parsed.baseUrl = baseUrl
  }
  for (const key of [...NULLABLE_TEXT_FIELDS, ...SECRET_FIELDS]) {
    if (!applyNullable(body, parsed, key)) return null
  }

  return parsed as GitAppCreate
}

export function parseGitAppPatchBody(body: unknown): GitAppUpdate | null {
  if (!isPlainObject(body)) return null

  const parsed: Record<string, unknown> = {}

  for (const key of ['name', 'externalAppId', 'baseUrl'] as const) {
    if (!(key in body)) continue
    const value = readRequiredString(body[key])
    if (!value) return null
    parsed[key] = value
  }
  for (const key of [...NULLABLE_TEXT_FIELDS, ...SECRET_FIELDS]) {
    if (!applyNullable(body, parsed, key)) return null
  }

  // `provider` and `organizationId` are immutable: changing either would move
  // the app to a different verification lane or a different tenant while its
  // installations kept pointing at it.
  if ('provider' in body || 'organizationId' in body) return null

  return parsed as GitAppUpdate
}

export type SerializedGitApp = GitAppSummary & {
  /** Ingress path this app's deliveries should arrive on. */
  webhookPath: string
  /** Absolute URL, when the instance knows a public origin. */
  webhookUrl: string | null
  /** `true` when this app is instance-wide and the caller is org-scoped. */
  readOnly: boolean
}

/**
 * Fold the routing URL onto a summary.
 *
 * `readOnly` is computed rather than stored: the same instance-wide row is
 * editable through the admin surface and read-only through an organization's,
 * so it is a property of the view, not of the record.
 */
export function serializeGitApp(
  app: GitAppSummary,
  opts: { publicOrigin: string | null; viewerOrganizationId: string | null },
): SerializedGitApp {
  const webhookPath = webhookPathFor(app.provider as WebhookProvider, app.webhookRef)
  return {
    ...app,
    webhookPath,
    webhookUrl: opts.publicOrigin
      ? `${opts.publicOrigin.replace(/\/$/, '')}${webhookPath}`
      : null,
    readOnly: opts.viewerOrganizationId !== null && app.organizationId === null,
  }
}
