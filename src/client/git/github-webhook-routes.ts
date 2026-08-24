/**
 * Inbound GitHub App webhook surface (`GITHUB_WEBHOOK_PATH`).
 *
 * This is the one HTTP surface in the codebase with no session and no daemon
 * JWT. GitHub is the caller, and its only credential is an HMAC over the body,
 * so the route is mounted on the **top-level app** rather than under
 * `CLIENT_API_PREFIX` (session middleware and the cross-origin write gate would
 * both be wrong here) and authenticates itself. See `./AGENTS.md`.
 *
 * Order of the gate matters and is load-bearing:
 *   1. rate limit — cheapest, and it is what protects the HMAC work below;
 *   2. read the **raw bytes** (never `c.req.json()`, which re-encodes and would
 *      invalidate the signature);
 *   3. verify the signature;
 *   4. claim the delivery id (only now, so an unsigned request cannot burn a
 *      delivery id a genuine redelivery would need);
 *   5. parse and dispatch.
 *
 * Every answer is fast, and the status code says whether GitHub should come
 * back. A non-2xx means "retry me", and no amount of retrying fixes an unplaced
 * environment or a disarmed source, so unroutable deliveries are logged and
 * answered 2xx. An instance-side fault — the command queue down, a deploy that
 * could not be enqueued — is the opposite: the commit is still deployable and a
 * redelivery is the only thing that can recover it, so those answer `503` *and*
 * release the delivery claim, because GitHub retries with the same delivery id
 * and a claim left behind would turn the retry into a `204`.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDb, type Db } from '../../db.ts'
import { GITHUB_WEBHOOK_PATH } from '../../surfaces.ts'
import { logInfo, logWarn } from '../../logger.ts'
import type { RateLimiter } from '../../daemon/rate-limit/contracts.ts'
import { githubWebhookRateLimitKey } from '../../daemon/rate-limit/keys.ts'
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
} from '../../lib/db/webhook-delivery-records.ts'
import { getGithubAppConfig } from '../../lib/git/github-app-config.ts'
import {
  branchFromGitRef,
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
} from '../../lib/git/github-webhook.ts'
import { resolveClientIp } from '../authn/http.ts'
import { assertDeployDispatchInfrastructure } from '../environments/deploy-routes.ts'
import {
  githubInstallationExternalId as installationExternalId,
  githubProvider,
} from '../../lib/git/github-provider.ts'
import {
  applyGithubInstallationEvent,
  resolveGithubCheckTrigger,
  resolveGithubPushTrigger,
  triggerSummaryNeedsRetry,
} from '../sources/webhook-trigger.ts'

/**
 * Hard ceiling on an accepted delivery body.
 *
 * GitHub's own documented cap is 25 MB, but the payloads this surface acts on
 * (`push`, `check_suite`, `installation`) are orders of magnitude smaller, and
 * the bytes are buffered in memory to be MAC'd. 1 MB is well clear of a real
 * push event (even one with hundreds of commits) while keeping a hostile caller
 * from making the instance hold an arbitrary buffer before authentication.
 */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

export type GithubWebhookRouteOpts = {
  /** Runtime, for trusted client-IP resolution. */
  runtime: 'deno' | 'workers'
  /** Dedicated bucket; see `githubWebhookRateLimitKey`. */
  rateLimiter?: RateLimiter
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What one dispatched delivery decided.
 *
 * `retry` is the whole reason this is a record rather than a bare result: the
 * handlers below produce two very different kinds of "did not deploy", and only
 * one of them should bring GitHub back. A configuration skip (auto-deploy off,
 * an unwatched branch, no placement) will look identical on every retry, so it
 * answers 2xx; a fault on this instance (no command queue, a deploy that failed
 * to enqueue) will not, so it answers 5xx.
 */
type DeliveryOutcome = {
  /** Instance-side fault: answer 5xx and release the delivery claim. */
  retry: boolean
  result: unknown
}

/** Final: log it and answer 2xx. */
function accepted(result: unknown): DeliveryOutcome {
  return { retry: false, result }
}

/** This instance could not act; a redelivery could. */
function retryable(reason: string): DeliveryOutcome {
  return { retry: true, result: { error: reason } }
}


/**
 * Read the delivery body as bytes.
 *
 * `c.req.arrayBuffer()` — not `c.req.json()`. The signature covers the exact
 * bytes GitHub sent, and Hono's JSON helper parses (and would let a later
 * re-serialize silently change them). The parse happens afterwards, on this
 * same buffer.
 */
async function readRawBody(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  const declared = Number.parseInt(c.req.header('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }
  const buffer = await c.req.arrayBuffer()
  if (buffer.byteLength > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
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

/**
 * The suite-level check rule now lives with the rest of GitHub's payload
 * vocabulary in `src/lib/git/github-provider.ts`, so the GitLab surface can be
 * written against the same interface. Re-exported unchanged — it is part of
 * this module's tested surface.
 */
export { successfulCheckSha } from '../../lib/git/github-provider.ts'

async function handlePush(
  c: Context<AppEnv>,
  db: Db,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  // `githubProvider.parsePush` applies the branch-ref and identification rules;
  // `null` means the delivery is not a branch push this instance can route.
  const push = githubProvider.parsePush(payload)
  if (!push) {
    const branch = branchFromGitRef(typeof payload.ref === 'string' ? payload.ref : null)
    return accepted({ skipped: branch ? 'unidentified_delivery' : 'non_branch_ref' })
  }

  // Deleting a branch is delivered as a push whose `after` is the all-zero SHA
  // (`isCommitSha` rejects it) with `deleted: true`. There is no head to
  // build, so it is not a deploy trigger for any `autoDeploy` mode — dropping it
  // here keeps a delete from redeploying the previous state on an `immediate`
  // source, and from being indistinguishable from a real push downstream.
  if (push.deleted) return accepted({ skipped: 'branch_deleted' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolveGithubPushTrigger(c, db, commandQueue, {
    externalInstallationId: push.externalInstallationId,
    repositoryExternalId: push.repositoryExternalId,
    ref: push.ref,
    branch: push.branch,
    commitSha: push.commitSha,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

async function handleChecks(
  c: Context<AppEnv>,
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  // All-checks-green only: see `successfulCheckSha`. A single green `check_run`
  // inside a suite that is still running (or that later fails) is not a release
  // signal and never reaches the trigger.
  const check = githubProvider.parseCheck(event, payload)
  if (!check) return accepted({ skipped: 'checks_not_successful' })

  const commandQueue = assertDeployDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return retryable('dispatch_unavailable')

  const summary = await resolveGithubCheckTrigger(c, db, commandQueue, {
    externalInstallationId: check.externalInstallationId,
    repositoryExternalId: check.repositoryExternalId,
    commitSha: check.commitSha,
  })
  return { retry: triggerSummaryNeedsRetry(summary), result: summary }
}

/**
 * `installation` / `installation_repositories`.
 *
 * Only the installation's own lifecycle is acted on. Repository add/remove is
 * logged and otherwise ignored in this phase: dropping `source` rows because a
 * repository left the installation's selection would destroy operator
 * configuration on what is very often a temporary change, and the clone would
 * fail loudly anyway once the token no longer covers it.
 */
async function handleInstallation(
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const installation = installationExternalId(payload)
  if (!installation) return accepted({ skipped: 'unidentified_delivery' })

  if (event === 'installation_repositories') {
    logInfo(
      'git-webhook',
      `installation_repositories ${String(payload.action)} for ${installation} ` +
        '(no source rows changed)',
    )
    return accepted({ skipped: 'repositories_noted' })
  }

  const action = typeof payload.action === 'string' ? payload.action : ''
  return accepted(
    await applyGithubInstallationEvent(db, {
      externalInstallationId: installation,
      action,
    }),
  )
}

async function dispatchDelivery(
  c: Context<AppEnv>,
  db: Db,
  event: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  switch (event) {
    case 'push':
      return await handlePush(c, db, payload)
    case 'check_suite':
    case 'check_run':
      return await handleChecks(c, db, event, payload)
    case 'installation':
    case 'installation_repositories':
      return await handleInstallation(db, event, payload)
    default:
      return accepted({ skipped: 'event_not_handled' })
  }
}

/**
 * Mount the webhook surface.
 *
 * Registered directly on the app from each entrypoint (`deno-server.ts`,
 * `workers.ts`) next to the daemon API, **not** inside `registerClientRoutes` —
 * the client router carries session middleware this surface must not inherit.
 */
export function registerGithubWebhookRoutes(
  app: Hono<AppEnv>,
  opts: GithubWebhookRouteOpts,
) {
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    // 1. Rate limit first — the HMAC below is the work being protected.
    if (opts.rateLimiter) {
      const peer = resolveClientIp(c, opts.runtime) ?? 'unknown'
      const { success } = await opts.rateLimiter.limit({
        key: githubWebhookRateLimitKey(peer),
      })
      if (!success) return c.json({ error: 'Too many requests' }, 429)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const config = await getGithubAppConfig(db, dataEncryptionSecrets)
    if (!config?.webhookSecret) {
      // Nothing to verify against: refuse rather than accept unauthenticated
      // deliveries. 503 (not 401) because the gap is on this side.
      return c.json({ error: 'github_app_not_configured' }, 503)
    }

    // 2. Raw bytes, before any parse.
    const raw = await readRawBody(c)
    if (raw instanceof Response) return raw

    // 3. Signature. Nothing has been written yet.
    const verified = await githubProvider.verifyWebhook(config.webhookSecret, raw, {
      get: (name) => c.req.header(name) ?? null,
    })
    if (!verified) {
      logWarn('git-webhook', 'rejected delivery with invalid signature')
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const event = c.req.header(GITHUB_EVENT_HEADER)?.trim() ?? ''
    const deliveryId = c.req.header(GITHUB_DELIVERY_HEADER)?.trim() ?? ''
    if (!event || !deliveryId) return c.json({ error: 'Invalid request' }, 400)

    // 4. Claim the delivery. A redelivery of work already done answers 204
    //    without re-running it.
    const claimed = await claimWebhookDelivery(db, {
      provider: 'github',
      externalDeliveryId: deliveryId,
      event,
    })
    if (!claimed) {
      logInfo('git-webhook', `duplicate delivery ${deliveryId} (${event}) ignored`)
      return c.body(null, 204)
    }

    // 5. Parse and act.
    const payload = parseDeliveryPayload(raw)
    if (!payload) return c.json({ error: 'Invalid request' }, 400)

    const outcome = await dispatchDelivery(c, db, event, payload)
    if (outcome.retry) {
      // Give the delivery id back before answering: GitHub redelivers with the
      // same id, and the claim taken in step 4 would otherwise make that retry a
      // duplicate `204` — the commit would be dropped with nothing left to
      // recover it from.
      await releaseWebhookDelivery(db, {
        provider: 'github',
        externalDeliveryId: deliveryId,
      })
      logWarn(
        'git-webhook',
        `delivery ${deliveryId} (${event}) could not be acted on; asking GitHub to retry`,
      )
      return c.json({ ok: false as const, event, result: outcome.result }, 503)
    }
    return c.json({ ok: true as const, event, result: outcome.result })
  })
}
