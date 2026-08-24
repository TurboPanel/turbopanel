/**
 * Inbound GitLab webhook surface (`GITLAB_WEBHOOK_PATH`).
 *
 * The same shape as `./github-webhook-routes.ts` — session-free, mounted on the
 * top-level app, and running the identical five-step gate — with one weaker
 * credential and one missing header. Both are GitLab's, not ours:
 *
 *  - **No signature.** GitLab does not MAC the body; it echoes the configured
 *    secret back in `X-Gitlab-Token`. The raw bytes are still read before
 *    anything is parsed, so the two surfaces stay structurally identical, but
 *    what admits the request is possession of the shared token, compared in
 *    constant time (`src/lib/git/gitlab-webhook.ts`).
 *  - **No guaranteed delivery id.** `X-Gitlab-Event-UUID` exists on recent
 *    versions; where it does not, the body is hashed. A redelivery carries
 *    byte-identical JSON and therefore the same claim, which is exactly what
 *    the ledger needs.
 *
 * Order of the gate matters and is load-bearing:
 *   1. rate limit — cheapest, and it is what protects the work below;
 *   2. read the **raw bytes** (also what the fallback delivery id hashes);
 *   3. verify the token;
 *   4. claim the delivery id (only now, so an unauthenticated request cannot
 *      burn an id a genuine redelivery would need);
 *   5. parse and dispatch.
 *
 * Status codes carry the same meaning as on the GitHub surface: 2xx for
 * anything a retry cannot change, `503` **plus a released claim** for an
 * instance-side fault the redelivery could still recover.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDb, type Db } from '../../db.ts'
import { GITLAB_WEBHOOK_PATH } from '../../surfaces.ts'
import { logInfo, logWarn } from '../../logger.ts'
import type { RateLimiter } from '../../daemon/rate-limit/contracts.ts'
import { gitlabWebhookRateLimitKey } from '../../daemon/rate-limit/keys.ts'
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
} from '../../lib/db/webhook-delivery-records.ts'
import { getGitlabOauthConfig } from '../../lib/git/gitlab-oauth-config.ts'
import { gitlabProvider } from '../../lib/git/gitlab-provider.ts'
import {
  gitlabDeliveryId,
  gitlabEventName,
  GITLAB_EVENT_HEADER,
  GITLAB_EVENT_UUID_HEADER,
} from '../../lib/git/gitlab-webhook.ts'
import { resolveClientIp } from '../authn/http.ts'
import { assertDeployDispatchInfrastructure } from '../environments/deploy-routes.ts'
import {
  resolveCheckTrigger,
  resolvePushTrigger,
  triggerSummaryNeedsRetry,
} from '../sources/webhook-trigger.ts'

/**
 * Hard ceiling on an accepted delivery body.
 *
 * Same reasoning and same number as the GitHub surface: the events acted on
 * here are orders of magnitude smaller, and the bytes are buffered in memory
 * before the caller has authenticated.
 */
export const GITLAB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

export type GitlabWebhookRouteOpts = {
  /** Runtime, for trusted client-IP resolution. */
  runtime: 'deno' | 'workers'
  /** Dedicated bucket; see `gitlabWebhookRateLimitKey`. */
  rateLimiter?: RateLimiter
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** See the GitHub surface's `DeliveryOutcome` — identical contract. */
type DeliveryOutcome = {
  /** Instance-side fault: answer 5xx and release the delivery claim. */
  retry: boolean
  result: unknown
}

function accepted(result: unknown): DeliveryOutcome {
  return { retry: false, result }
}

function retryable(reason: string): DeliveryOutcome {
  return { retry: true, result: { error: reason } }
}

async function readRawBody(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  const declared = Number.parseInt(c.req.header('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > GITLAB_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }
  const buffer = await c.req.arrayBuffer()
  if (buffer.byteLength > GITLAB_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }
  return new Uint8Array(buffer)
}

function parseDeliveryPayload(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function handlePush(
  c: Context<AppEnv>,
  db: Db,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const push = gitlabProvider.parsePush(payload)
  if (!push) return accepted({ skipped: 'non_branch_ref' })
  // A branch delete carries no head SHA, so there is nothing to build for any
  // `autoDeploy` mode — same rule as the GitHub surface.
  if (push.deleted) return accepted({ skipped: 'branch_deleted' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolvePushTrigger(c, db, commandQueue, {
    provider: 'gitlab',
    ...push,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

async function handlePipeline(
  c: Context<AppEnv>,
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  // Pipeline-level success only — GitLab's analogue of a green `check_suite`.
  // A `Job Hook` describes one job and is deliberately not a release signal.
  const check = gitlabProvider.parseCheck(event, payload)
  if (!check) return accepted({ skipped: 'checks_not_successful' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolveCheckTrigger(c, db, commandQueue, {
    provider: 'gitlab',
    ...check,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

/**
 * Dispatch on GitLab's `object_kind`, not on the header.
 *
 * `X-Gitlab-Event` carries a display name (`Push Hook`) whose spelling has
 * shifted across versions and differs again for system hooks, while
 * `object_kind` is part of the payload contract and stable. The header is still
 * recorded on the delivery row for tracing.
 */
async function dispatchDelivery(
  c: Context<AppEnv>,
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const kind = typeof payload.object_kind === 'string' ? payload.object_kind : event
  switch (kind) {
    case 'push':
      return await handlePush(c, db, payload)
    case 'pipeline':
      return await handlePipeline(c, db, kind, payload)
    default:
      // Notably absent: an installation lifecycle case. GitLab has no such
      // webhook — a revoked OAuth grant surfaces as a failing token refresh at
      // deploy time, not as a delivery. See `gitlab-provider.ts`.
      return accepted({ skipped: 'event_not_handled' })
  }
}

/**
 * Mount the webhook surface.
 *
 * Registered directly on the app from each entrypoint (`deno-server.ts`,
 * `workers.ts`) next to the daemon API and the GitHub surface, **not** inside
 * `registerClientRoutes` — the client router carries session middleware this
 * surface must not inherit.
 */
export function registerGitlabWebhookRoutes(
  app: Hono<AppEnv>,
  opts: GitlabWebhookRouteOpts,
) {
  app.post(GITLAB_WEBHOOK_PATH, async (c) => {
    // 1. Rate limit first — it is what protects the work below.
    if (opts.rateLimiter) {
      const peer = resolveClientIp(c, opts.runtime) ?? 'unknown'
      const { success } = await opts.rateLimiter.limit({
        key: gitlabWebhookRateLimitKey(peer),
      })
      if (!success) return c.json({ error: 'Too many requests' }, 429)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const config = await getGitlabOauthConfig(db, dataEncryptionSecrets)
    if (!config?.webhookSecret) {
      // Nothing to verify against: refuse rather than accept unauthenticated
      // deliveries. 503 (not 401) because the gap is on this side.
      return c.json({ error: 'gitlab_webhook_not_configured' }, 503)
    }

    // 2. Raw bytes, before any parse — also what the fallback delivery id hashes.
    const raw = await readRawBody(c)
    if (raw instanceof Response) return raw

    // 3. Token. Nothing has been written yet.
    const verified = await gitlabProvider.verifyWebhook(config.webhookSecret, raw, {
      get: (name) => c.req.header(name) ?? null,
    })
    if (!verified) {
      logWarn('git-webhook', 'rejected gitlab delivery with invalid token')
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const event = gitlabEventName(c.req.header(GITLAB_EVENT_HEADER))
    if (!event) return c.json({ error: 'Invalid request' }, 400)
    const deliveryId = await gitlabDeliveryId(
      c.req.header(GITLAB_EVENT_UUID_HEADER),
      raw,
    )

    // 4. Claim the delivery. A redelivery of work already done answers 204
    //    without re-running it.
    const claimed = await claimWebhookDelivery(db, {
      provider: 'gitlab',
      externalDeliveryId: deliveryId,
      event,
    })
    if (!claimed) {
      logInfo('git-webhook', `duplicate gitlab delivery (${event}) ignored`)
      return c.body(null, 204)
    }

    // 5. Parse and act.
    const payload = parseDeliveryPayload(raw)
    if (!payload) return c.json({ error: 'Invalid request' }, 400)

    const outcome = await dispatchDelivery(c, db, event, payload)
    if (outcome.retry) {
      // Give the delivery id back before answering: a resend carries the same
      // id (or hashes to it), and the claim taken in step 4 would otherwise
      // make that retry a duplicate `204` — the commit would be dropped with
      // nothing left to recover it from.
      await releaseWebhookDelivery(db, {
        provider: 'gitlab',
        externalDeliveryId: deliveryId,
      })
      logWarn(
        'git-webhook',
        `gitlab delivery (${event}) could not be acted on; asking for a resend`,
      )
      return c.json({ ok: false as const, event, result: outcome.result }, 503)
    }
    return c.json({ ok: true as const, event, result: outcome.result })
  })
}
