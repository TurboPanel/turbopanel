/**
 * GitLab deliveries.
 *
 * The ordering, the delivery ledger and the retry contract live in
 * `../gate.ts`. What is GitLab-specific is one weaker credential and one
 * missing header, and both are GitLab's, not ours:
 *
 *  - **No signature.** GitLab does not MAC the body; it echoes the configured
 *    secret back in `X-Gitlab-Token`. The gate still reads raw bytes before
 *    anything is parsed — the two surfaces stay structurally identical — but
 *    what admits the request is possession of the shared token, compared in
 *    constant time (`src/lib/git/gitlab-webhook.ts`).
 *  - **No guaranteed delivery id.** `X-Gitlab-Event-UUID` exists on recent
 *    versions; where it does not, the body is hashed. A redelivery carries
 *    byte-identical JSON and therefore the same claim, which is exactly what
 *    the ledger wants.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import {
  GITLAB_WEBHOOK_PATH,
  GITLAB_WEBHOOK_SCOPED_PATH,
} from '../../surfaces.ts'
import { gitlabWebhookRateLimitKey } from '../../daemon/rate-limit/keys.ts'
import { gitlabProvider } from '../../lib/git/gitlab-provider.ts'
import { resolveGitlabWebhookApp } from '../../lib/git/resolve-webhook-app.ts'
import type { GitApp } from '../../lib/git/git-app-records.ts'
import {
  gitlabDeliveryId,
  gitlabEventName,
  GITLAB_EVENT_HEADER,
  GITLAB_EVENT_UUID_HEADER,
  GITLAB_TOKEN_HEADER,
} from '../../lib/git/gitlab-webhook.ts'
import { assertDeployDispatchInfrastructure } from '../../client/environments/deploy-routes.ts'
import {
  resolveCheckTrigger,
  resolvePushTrigger,
  triggerSummaryNeedsRetry,
} from '../../client/sources/webhook-trigger.ts'
import {
  accepted,
  type DeliveryOutcome,
  registerWebhookGate,
  retryable,
  type WebhookGate,
  type WebhookGateOpts,
} from '../gate.ts'

/**
 * Hard ceiling on an accepted delivery body.
 *
 * Same reasoning and same number as the GitHub surface: the events acted on
 * here are orders of magnitude smaller, and the bytes are buffered in memory
 * before the caller has authenticated.
 */
export const GITLAB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

async function handlePush(
  c: Context<AppEnv>,
  db: Db,
  appId: string,
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
    appId,
    ...push,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

async function handlePipeline(
  c: Context<AppEnv>,
  db: Db,
  appId: string,
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
    appId,
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
  appId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const kind = typeof payload.object_kind === 'string' ? payload.object_kind : event
  switch (kind) {
    case 'push':
      return await handlePush(c, db, appId, payload)
    case 'pipeline':
      return await handlePipeline(c, db, appId, kind, payload)
    default:
      // Notably absent: an installation lifecycle case. GitLab has no such
      // webhook — a revoked OAuth grant surfaces as a failing token refresh at
      // deploy time, not as a delivery. See `gitlab-provider.ts`.
      return accepted({ skipped: 'event_not_handled' })
  }
}

const gitlabGate: WebhookGate<GitApp> = {
  kind: 'gitlab',
  logScope: 'git-webhook',
  maxBodyBytes: GITLAB_WEBHOOK_MAX_BODY_BYTES,
  rateLimitKey: gitlabWebhookRateLimitKey,

  async resolve(ctx, ref) {
    const resolution = await resolveGitlabWebhookApp(
      ctx.db,
      ctx.dataEncryptionSecrets,
      ref,
      ctx.headers.get(GITLAB_TOKEN_HEADER),
    )
    if (resolution.ok) return { ok: true, candidates: resolution.candidates }
    return { ok: false, reason: 'names no registered app' }
  },

  isUnconfigured: (app) => !app.webhookSecret,
  unconfiguredError: 'gitlab_webhook_not_configured',

  verify: (app, raw, ctx) =>
    gitlabProvider.verifyWebhook(app.webhookSecret ?? '', raw, ctx.headers),

  // The UUID when present, else a digest of the body — see the header note.
  deliveryId: (ctx, raw) =>
    gitlabDeliveryId(ctx.headers.get(GITLAB_EVENT_UUID_HEADER), raw),

  // The ledger records the header's display name for tracing; `dispatchDelivery`
  // below discriminates on the payload's `object_kind` instead.
  eventName: (ctx) => gitlabEventName(ctx.headers.get(GITLAB_EVENT_HEADER)) || null,

  dispatch: (ctx, app, event, payload) =>
    dispatchDelivery(ctx.c, ctx.db, app.id, event, payload),
}

export function registerGitlabWebhookRoutes(app: Hono<AppEnv>, opts: WebhookGateOpts) {
  registerWebhookGate(
    app,
    [GITLAB_WEBHOOK_SCOPED_PATH, GITLAB_WEBHOOK_PATH],
    gitlabGate,
    opts,
  )
}
