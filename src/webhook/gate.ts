/**
 * The webhook gate: one ordered sequence, written once.
 *
 * Every inbound webhook this instance accepts runs the same six steps in the
 * same order, and the order is not stylistic — three of the steps are security
 * properties:
 *
 *   1. **rate limit** — cheapest, and it is what protects the verification work
 *      below from being spent by an unauthenticated caller;
 *   2. **resolve** — work out *whose* secret this delivery should be checked
 *      against. Selection only; nothing here is trusted yet;
 *   3. **raw bytes** — `c.req.arrayBuffer()`, never `c.req.json()`. A signature
 *      covers the exact bytes the sender sent, and parsing then re-encoding
 *      changes key order and escapes;
 *   4. **verify** — against the resolved holder's own secret;
 *   5. **claim the delivery id** — only now. Claiming before verification would
 *      let an unauthenticated request burn the id a genuine redelivery needs;
 *   6. **parse and dispatch**.
 *
 * Until this module existed, that sequence lived twice — once in the GitHub
 * route and once in GitLab's — with nothing keeping the two in step. A third
 * kind would have been a third copy of the claim/release semantics, which are
 * the easiest part to get subtly and silently wrong.
 *
 * ## The status code is a retry instruction
 *
 * A non-2xx tells the sender "come back". No amount of retrying fixes an
 * unplaced environment or a disarmed source, so an unroutable delivery is logged
 * and answered 2xx. An instance-side fault is the opposite: the event is still
 * actionable and a redelivery is the only thing that can recover it, so those
 * answer `503` **and release the claim** — because the sender retries with the
 * same id, and a claim left behind would turn that retry into a `204` and drop
 * the event with nothing left to recover it from.
 *
 * ## Adding a kind
 *
 * Implement {@link WebhookGate} and register it. The gate is generic over
 * `THolder` — whatever that kind verifies against — so a kind with no tenant at
 * all (one instance-wide secret) is as expressible as a multi-tenant one:
 * `resolve` just returns a single holder carrying only the secret. `verify`
 * receives the raw bytes and may parse them itself, which is what a sender that
 * signs *fields* rather than the whole body needs, without moving the parse
 * ahead of verification.
 */

import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { getDb, type Db } from '../db.ts'
import { logInfo, logWarn } from '../logger.ts'
import type { RateLimiter } from '../daemon/rate-limit/contracts.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
  type WebhookDeliveryProvider,
} from '../lib/db/webhook-delivery-records.ts'
import { resolveClientIp } from '../client/authn/http.ts'

/** Case-insensitive header access, so an adapter never touches Hono directly. */
export type HeaderReader = { get(name: string): string | null }

/** What a gate step is handed. Everything it may legitimately need, and no more. */
export type GateContext = {
  c: Context<AppEnv>
  db: Db
  dataEncryptionSecrets: DerivedSecretsConfig
  headers: HeaderReader
}

/**
 * Candidates that might own this delivery, best first.
 *
 * A list rather than one row because identity can be ambiguous before
 * verification — a numeric GitHub App id, for instance, is unique per origin
 * rather than globally. The gate tries each in turn and keeps the one whose
 * secret actually verifies.
 */
export type GateResolution<THolder> =
  | { ok: true; candidates: THolder[] }
  | { ok: false; reason: string }

/**
 * What one dispatched delivery decided.
 *
 * A record rather than a bare result because there are two very different kinds
 * of "did nothing", and only one of them should bring the sender back.
 */
export type DeliveryOutcome = {
  /** Instance-side fault: answer 5xx and release the delivery claim. */
  retry: boolean
  result: unknown
}

/** Final: log it and answer 2xx. */
export function accepted(result: unknown): DeliveryOutcome {
  return { retry: false, result }
}

/** This instance could not act; a redelivery could. */
export function retryable(reason: string): DeliveryOutcome {
  return { retry: true, result: { error: reason } }
}

export type WebhookGate<THolder> = {
  /**
   * Ledger key and log prefix.
   *
   * Must be a value `delivery_provider_check` accepts — the claim in step 5
   * writes it.
   */
  kind: WebhookDeliveryProvider
  /** Log namespace, e.g. `git-webhook`. */
  logScope: string
  /**
   * Hard ceiling on an accepted body.
   *
   * The bytes are buffered in memory *before* the caller has authenticated, so
   * this is what stops a hostile sender making the instance hold an arbitrary
   * buffer.
   */
  maxBodyBytes: number
  /** Per-peer bucket. The caller has no identity until step 4 succeeds. */
  rateLimitKey(peer: string): string
  /** Step 2. Selection only — nothing returned here is trusted. */
  resolve(ctx: GateContext, ref: string | null): Promise<GateResolution<THolder>>
  /** True when this holder has no secret configured — a gap on our side, not a rejection. */
  isUnconfigured(holder: THolder): boolean
  /** Answered when every candidate is unconfigured. */
  unconfiguredError: string
  /** Step 4. */
  verify(holder: THolder, raw: Uint8Array, ctx: GateContext): Promise<boolean>
  /** Stable id for the replay ledger. `null` rejects the delivery as malformed. */
  deliveryId(ctx: GateContext, raw: Uint8Array): Promise<string | null>
  /**
   * Ledger label. `null` rejects the delivery as malformed.
   *
   * Takes the raw bytes rather than a parsed payload so this stays *before* the
   * claim, preserving the original ordering. A kind whose event name lives in
   * the body may parse `raw` itself — the same escape hatch {@link verify} uses.
   */
  eventName(ctx: GateContext, raw: Uint8Array): string | null
  /** Step 6. */
  dispatch(
    ctx: GateContext,
    holder: THolder,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DeliveryOutcome>
}

export type WebhookGateOpts = {
  /** Runtime, for trusted client-IP resolution. */
  runtime: 'deno' | 'workers'
  rateLimiter?: RateLimiter
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePayload(raw: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Pick the candidate whose secret actually verifies the delivery.
 *
 * Candidates with no configured secret are skipped rather than treated as a
 * pass — the difference between "not set up" and "authenticated" is the whole
 * point of the step.
 */
async function selectVerified<THolder>(
  gate: WebhookGate<THolder>,
  candidates: THolder[],
  raw: Uint8Array,
  ctx: GateContext,
): Promise<THolder | null> {
  for (const candidate of candidates) {
    if (gate.isUnconfigured(candidate)) continue
    if (await gate.verify(candidate, raw, ctx)) return candidate
  }
  return null
}

/**
 * Mount one gate on every path it answers.
 *
 * Flat `app.post` registrations against the absolute paths in
 * `src/surfaces.ts`, rather than a child router mounted at the prefix — two
 * gates share `/webhook`, and a child would be one more object to thread
 * through `registerWebhookRoutes` for no behaviour.
 *
 * No `.use('*')`: `/webhook` must stay out of every protected prefix
 * (`src/browser-write-protection.ts`). Session middleware would reject every
 * delivery, and the caller sends no `Origin` for the cross-origin gate to read.
 */
export function registerWebhookGate<THolder>(
  app: Hono<AppEnv>,
  paths: readonly string[],
  gate: WebhookGate<THolder>,
  opts: WebhookGateOpts,
): void {
  const handler = async (c: Context<AppEnv>) => {
    // 1. Rate limit first — it is what protects the verification work below.
    if (opts.rateLimiter) {
      const peer = resolveClientIp(c, opts.runtime) ?? 'unknown'
      const { success } = await opts.rateLimiter.limit({
        key: gate.rateLimitKey(peer),
      })
      if (!success) return c.json({ error: 'Too many requests' }, 429)
    }

    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const ctx: GateContext = {
      c,
      db,
      dataEncryptionSecrets,
      headers: { get: (name: string) => c.req.header(name) ?? null },
    }

    // 2. Whose delivery is this? Selection only.
    const ref = c.req.param('ref')?.trim() || null
    const resolution = await gate.resolve(ctx, ref)
    if (!resolution.ok) {
      logWarn(gate.logScope, `rejected delivery: ${resolution.reason}`)
      return c.json({ error: 'Unauthorized' }, 401)
    }
    if (resolution.candidates.every((holder) => gate.isUnconfigured(holder))) {
      // Nothing to verify against. 503, not 401: refuse rather than accept an
      // unauthenticated delivery, but say the gap is on this side.
      return c.json({ error: gate.unconfiguredError }, 503)
    }

    // 3. Raw bytes, before any parse.
    const declared = Number.parseInt(c.req.header('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > gate.maxBodyBytes) {
      return c.json({ error: 'Payload too large' }, 413)
    }
    const buffer = await c.req.arrayBuffer()
    if (buffer.byteLength > gate.maxBodyBytes) {
      return c.json({ error: 'Payload too large' }, 413)
    }
    const raw = new Uint8Array(buffer)

    // 4. Verify against the resolved holder's own secret.
    const holder = await selectVerified(gate, resolution.candidates, raw, ctx)
    if (!holder) {
      logWarn(gate.logScope, 'rejected delivery with an invalid credential')
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const deliveryId = await gate.deliveryId(ctx, raw)
    if (!deliveryId) return c.json({ error: 'Invalid request' }, 400)

    const event = gate.eventName(ctx, raw)
    if (!event) return c.json({ error: 'Invalid request' }, 400)

    // 5. Claim the delivery. A redelivery of work already done answers 204
    //    without re-running it.
    const claimed = await claimWebhookDelivery(db, {
      provider: gate.kind,
      externalDeliveryId: deliveryId,
      event,
    })
    if (!claimed) {
      logInfo(gate.logScope, `duplicate delivery ${deliveryId} (${event}) ignored`)
      return c.body(null, 204)
    }

    // 6. Parse and act.
    const payload = parsePayload(raw)
    if (!payload) return c.json({ error: 'Invalid request' }, 400)

    const outcome = await gate.dispatch(ctx, holder, event, payload)
    if (outcome.retry) {
      // Give the id back before answering: the sender retries with the same one,
      // and a claim left behind would turn that retry into the `204` above.
      await releaseWebhookDelivery(db, {
        provider: gate.kind,
        externalDeliveryId: deliveryId,
      })
      logWarn(
        gate.logScope,
        `delivery ${deliveryId} (${event}) could not be acted on; asking for a retry`,
      )
      return c.json({ ok: false as const, event, result: outcome.result }, 503)
    }
    return c.json({ ok: true as const, event, result: outcome.result })
  }

  for (const path of paths) app.post(path, handler)
}
