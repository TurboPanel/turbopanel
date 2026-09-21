/**
 * Where a forge may live, as far as this instance is willing to dial it.
 *
 * A forge's `baseUrl` / `apiUrl` / `webhookOrigin` are typed in by an
 * organization admin and later fetched server-side with the App's credentials
 * attached (`github-provider.ts`, `gitlab-api.ts`, `github-app-token.ts`). An
 * address that points back inside the box — the loopback, a link-local
 * metadata endpoint, an RFC 1918 neighbour — turns "connect a self-hosted
 * GitLab" into "make the control plane read its own Postgres/RabbitMQ/Redis on
 * my behalf". Nothing else on the write path looked at the value beyond
 * "non-empty string" before this module existed.
 *
 * The rule itself now lives in `http/outbound-url.ts`, because it is not
 * forge-specific: every operator-supplied URL this instance fetches gets the
 * same treatment. What stays here is the forge vocabulary — which field was
 * refused, and the error type the forge routes catch.
 *
 * Two layers, on purpose:
 *
 * - {@link validateForgeUrl} runs at write time (create, patch, the manifest
 *   flow) and is pure — scheme, no credentials, no reserved names, and an IP
 *   literal has to classify as `public` under `ipAddressScope`.
 * - {@link assertForgeUrlAllowed} re-runs the same check at the two fetch-time
 *   choke points (`githubApiBaseFor`, `gitlabApiBase`), so a row that predates
 *   this module, or one written by anything other than the routes, is still
 *   refused before a credential leaves the process.
 *
 * DNS is resolved at write time only, and only where a resolver exists (the
 * Deno instance — Workers has none, and Cloudflare's egress cannot reach
 * private ranges anyway). A name that later re-points to a private address
 * (rebinding) is therefore not caught at fetch time; the compiled instance's
 * `--allow-net` allowlist is the second wall there (`deno.json` `compile`).
 */
import {
  type OutboundUrlRejection,
  resolveOutboundHostScope,
  validateOutboundUrl,
} from '../../lib/http/outbound-url.ts'

export type ForgeUrlField = 'baseUrl' | 'apiUrl' | 'webhookOrigin'

/** The forge fields' name for {@link OutboundUrlRejection}. */
export type ForgeUrlRejection = OutboundUrlRejection

export class ForgeUrlError extends Error {
  readonly field: ForgeUrlField
  readonly reason: ForgeUrlRejection
  constructor(field: ForgeUrlField, reason: ForgeUrlRejection) {
    super(`forge ${field} rejected: ${reason}`)
    this.name = 'ForgeUrlError'
    this.field = field
    this.reason = reason
  }
}

/**
 * Validate one forge URL field. Returns the reason it is refused, or `null`
 * when the URL is one this instance will dial.
 */
export function validateForgeUrl(raw: string): ForgeUrlRejection | null {
  return validateOutboundUrl(raw)
}

/** Throwing form for the fetch-time choke points. */
export function assertForgeUrlAllowed(field: ForgeUrlField, raw: string): string {
  const reason = validateForgeUrl(raw)
  if (reason) throw new ForgeUrlError(field, reason)
  return raw
}

/**
 * Resolve the name and refuse it if any answer is not a public address —
 * the write-time half of the check that a literal-only validator cannot do.
 * Only the Deno instance has a resolver; elsewhere this is a no-op that
 * resolves to `null`. A name that does not resolve at all is left to the
 * fetch to fail on, not refused here (the admin may be mid-DNS-setup).
 */
export async function resolveForgeHostScope(
  raw: string,
): Promise<ForgeUrlRejection | null> {
  return await resolveOutboundHostScope(raw)
}
