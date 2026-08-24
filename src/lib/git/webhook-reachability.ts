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
): WebhookReachability {
  const path = WEBHOOK_PATH_BY_PROVIDER[provider]
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
