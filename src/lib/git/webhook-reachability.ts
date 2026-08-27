/**
 * Can a provider actually deliver a webhook to this instance?
 *
 * TurboPanel runs happily on a LAN — `https://panel.lan:8443`, a private IP, a
 * `.internal` name — and everything else about a Git source works there:
 * cloning is outbound, token minting is outbound. Webhooks are the one inbound
 * hop, and on such an instance GitHub simply cannot reach it. The failure mode
 * is silent (deliveries pile up in GitHub's log; nothing deploys), so the API
 * says so up front instead of leaving the operator to discover it.
 *
 * This is a *hint*, computed from the operator's configured public URLs. It is
 * not a probe: nothing here dials anything, and a public-looking URL can still
 * be firewalled. The console shows the note; the manual `POST
 * /environments/:id/deploy` body's `ref` field is the documented way to work
 * without inbound delivery.
 */

import { isLoopbackOrPrivateHostname } from '../install-tls.ts'
import { GITHUB_WEBHOOK_PATH, GITLAB_WEBHOOK_PATH } from '../../surfaces.ts'
import { normalizeOrigin } from './origin.ts'

export type WebhookReachability = {
  /** Full URL to paste into the App's webhook settings, or `null` when unknown. */
  webhookUrl: string | null
  /** False when every configured origin looks LAN-only or none is configured. */
  reachable: boolean
  /** Operator-facing explanation when `reachable` is false; `null` otherwise. */
  note: string | null
}

const LAN_NOTE =
  'This instance’s public URL is on a private network, so the Git provider ' +
  'cannot deliver webhooks to it. Auto-deploy will not fire; deploy a specific ' +
  'commit with the `ref` field on POST /environments/:id/deploy instead.'

const NO_URL_NOTE =
  'No public URL is configured for this instance, so the webhook endpoint has ' +
  'no address to give the Git provider. Set one under instance settings, or ' +
  'deploy a specific commit with the `ref` field on POST /environments/:id/deploy.'

/** An https origin on a publicly routable host is assumed deliverable. */
function isPubliclyReachableOrigin(origin: string): boolean {
  const trimmed = origin.trim()
  if (!trimmed.startsWith('https://')) return false
  try {
    const url = new URL(trimmed)
    return !isLoopbackOrPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

/** Each provider has its own ingress path; the reachability rule is shared. */
export const WEBHOOK_PATH_BY_PROVIDER = {
  github: GITHUB_WEBHOOK_PATH,
  gitlab: GITLAB_WEBHOOK_PATH,
} as const

export type WebhookProvider = keyof typeof WEBHOOK_PATH_BY_PROVIDER

function webhookUrlFor(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path}`
}

/** The origins whose deliveries resolve without a ref in the path. */
const HOSTED_PROVIDER_ORIGINS: Record<WebhookProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
}

/**
 * Does an app on this origin need its ref in the URL?
 *
 * github.com stamps `X-GitHub-Hook-Installation-Target-ID` on every App
 * delivery and gitlab.com echoes the token we can digest, so a hosted app is
 * identifiable from the request alone and gets the clean path.
 *
 * A **self-hosted** origin is the case where that assumption is not ours to
 * make: GitHub Enterprise Server and self-managed GitLab ship on their own
 * release cadence, and a build that omits the header would 401 every delivery
 * with nothing in the URL to fall back to. Those get the ref.
 */
export function webhookPathNeedsRef(
  provider: WebhookProvider,
  baseUrl?: string | null,
): boolean {
  if (!baseUrl) return false
  return normalizeOrigin(baseUrl) !== HOSTED_PROVIDER_ORIGINS[provider]
}

/**
 * The ingress path for one app.
 *
 * Hosted providers get the bare path — clean, and with nothing internal in it.
 * Self-hosted ones get the app's `webhookRef` appended, which names the app
 * before any secret is consulted. Pass no `baseUrl` to get the bare path.
 */
export function webhookPathFor(
  provider: WebhookProvider,
  webhookRef?: string | null,
  baseUrl?: string | null,
): string {
  const base = WEBHOOK_PATH_BY_PROVIDER[provider]
  if (!webhookRef || !webhookPathNeedsRef(provider, baseUrl)) return base
  return `${base}/${encodeURIComponent(webhookRef)}`
}

/**
 * Classify the instance's configured origins.
 *
 * The first publicly reachable origin wins — that is the one worth handing to
 * GitHub. When none qualifies, the first configured origin is still returned so
 * the operator can see the endpoint's shape, paired with the note explaining
 * why it will not work as-is.
 */
export function webhookReachability(
  origins: readonly string[],
  provider: WebhookProvider = 'github',
  webhookRef?: string | null,
  baseUrl?: string | null,
): WebhookReachability {
  const path = webhookPathFor(provider, webhookRef, baseUrl)
  const usable = origins.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  if (usable.length === 0) {
    return { webhookUrl: null, reachable: false, note: NO_URL_NOTE }
  }

  const publicOrigin = usable.find(isPubliclyReachableOrigin)
  if (publicOrigin) {
    return { webhookUrl: webhookUrlFor(publicOrigin, path), reachable: true, note: null }
  }

  return {
    webhookUrl: webhookUrlFor(usable[0]!, path),
    reachable: false,
    note: LAN_NOTE,
  }
}

/** GitHub-specific alias kept for the callers (and test) that predate GitLab. */
export function githubWebhookReachability(
  origins: readonly string[],
): WebhookReachability {
  return webhookReachability(origins, 'github')
}
