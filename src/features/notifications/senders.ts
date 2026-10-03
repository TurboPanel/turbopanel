/**
 * One delivery attempt per channel kind — the bodies a webhook, Slack,
 * Discord or Telegram expect, and the contract every sender keeps:
 *
 * - **Never rejects.** A sender resolves to `{ ok }` or `{ ok: false, error }`;
 *   a thrown error is a bug. The emitter's job is to record what happened,
 *   never to fail because a chat service is down (the contract
 *   `alert-sender.ts` had, kept verbatim).
 * - **Bounded.** Every attempt is abandoned after {@link SEND_TIMEOUT_MS}.
 * - **The address is a credential.** Errors carry an HTTP status or a short
 *   code, never the URL, never a response body.
 *
 * Workers-bundle safe: `fetch` and `crypto.subtle` are reached for at call
 * time, never at module load.
 */
import type { NotificationDigestGroup } from '../email/types.ts'
import type { DeliveryPayload } from './records.ts'

export const SEND_TIMEOUT_MS = 5_000

export type SendOutcome = { ok: true } | { ok: false; error: string }

export type SendTarget = {
  kind: 'webhook' | 'slack' | 'discord' | 'telegram' | 'push' | 'email'
  /** Plain (unsealed) address. */
  address: string
  /** Plain signing secret for the generic webhook kind. */
  signingSecret?: string | null
}

/** The context as sorted `key=value` lines, nulls dropped — what an email lists and a chat line appends. */
export function renderDetails(payload: DeliveryPayload): string[] {
  return Object.keys(payload.context)
    .sort((a, b) => a.localeCompare(b))
    .filter((key) => payload.context[key] !== undefined && payload.context[key] !== null)
    .map((key) => `${key}=${payload.context[key]}`)
}

/** The line every chat-style receiver shows: the title, then the context as `key=value`. */
export function renderText(payload: DeliveryPayload): string {
  const parts = renderDetails(payload)
  const head = payload.body ? `${payload.title} — ${payload.body}` : payload.title
  return parts.length > 0 ? `${head} (${parts.join(' ')})` : head
}

/** The generic JSON body: everything a receiver could want, nothing secret. */
export function webhookBody(payload: DeliveryPayload): Record<string, unknown> {
  return {
    event: payload.event,
    severity: payload.severity,
    title: payload.title,
    body: payload.body,
    text: renderText(payload),
    organizationId: payload.organizationId,
    target: payload.targetType ? { type: payload.targetType, id: payload.targetId } : null,
    context: payload.context,
    at: payload.at,
  }
}

/** Slack, Mattermost, Rocket.Chat and Discord all read `text` / `content`. */
export function chatBody(
  kind: 'slack' | 'discord',
  payload: DeliveryPayload
): Record<string, unknown> {
  const text = renderText(payload)
  return kind === 'discord' ? { content: text } : { text }
}

export function telegramBody(chatId: string, payload: DeliveryPayload): Record<string, unknown> {
  return {
    chat_id: chatId,
    text: renderText(payload),
    disable_web_page_preview: true,
  }
}

const encoder = new TextEncoder()

/** `sha256=<hex>` over the raw body — what `X-TurboPanel-Signature` carries. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
  let hex = ''
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0')
  return `sha256=${hex}`
}

/**
 * A Telegram channel's address is one sealed string, `<bot token>/<chat id>`
 * (an optional `bot` prefix on the token is tolerated): the token is the
 * credential and the chat id the destination, and keeping them together means
 * one column, one seal, one thing to rotate.
 */
export function parseTelegramAddress(address: string): { token: string; chatId: string } | null {
  const slash = address.lastIndexOf('/')
  if (slash <= 0) return null
  const token = address.slice(0, slash).replace(/^bot/, '')
  const chatId = address.slice(slash + 1)
  if (!token || !chatId) return null
  return { token, chatId }
}

/** A 3xx, or the opaque-redirect a runtime returns for `redirect: "manual"`. */
function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<SendOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
      // Never follow: a 3xx could point at an internal address that the
      // send-time URL check never saw.
      redirect: 'manual',
    })
    // Drain so the connection can be reused rather than hang.
    await response.text().catch(() => undefined)
    if (isRedirect(response)) return { ok: false, error: 'redirect_blocked' }
    return response.ok ? { ok: true } : { ok: false, error: `http_${response.status}` }
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error'
    return { ok: false, error: name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** What one digest carries: the grouped events a window held (built by `digest.ts`). */
export type DigestMessage = {
  /** `hourly` / `daily`, or `quiet` when quiet hours alone held the events. */
  summary: 'hourly' | 'daily' | 'quiet'
  total: number
  groups: NotificationDigestGroup[]
  moreGroups: number
  consoleUrl: string | null
  at: string
}

/** Discord rejects over 2000 characters, Telegram over 4096: stay under the smaller. */
export const DIGEST_TEXT_MAX = 1900

const DIGEST_HEADS: Record<DigestMessage['summary'], string> = {
  hourly: 'hourly digest',
  daily: 'daily digest',
  quiet: 'held during quiet hours',
}

function digestLine(group: NotificationDigestGroup): string {
  const first = group.items[0]?.title ?? group.event
  const more = group.count > 1 ? ` (+${group.count - 1} more)` : ''
  return `- [${group.severity}] ${group.event} x${group.count}: ${first}${more}`
}

/** The compact text a chat channel gets: a head, one line per event kind, a link. Pure. */
export function digestText(digest: DigestMessage): string {
  const noun = digest.total === 1 ? 'event' : 'events'
  const lines = [`TurboPanel ${DIGEST_HEADS[digest.summary]}: ${digest.total} ${noun}`]
  lines.push(...digest.groups.map(digestLine))
  if (digest.moreGroups > 0) {
    lines.push(`...and ${digest.moreGroups} more kinds`)
  }
  if (digest.consoleUrl) lines.push(digest.consoleUrl)
  const text = lines.join('\n')
  return text.length <= DIGEST_TEXT_MAX ? text : `${text.slice(0, DIGEST_TEXT_MAX - 3)}...`
}

/** The webhook body of a digest: the grouped events as data, plus the same `text`. Nothing secret. */
export function digestWebhookBody(digest: DigestMessage): Record<string, unknown> {
  return {
    type: 'digest',
    summary: digest.summary,
    total: digest.total,
    text: digestText(digest),
    groups: digest.groups.map((g) => ({
      event: g.event,
      severity: g.severity,
      count: g.count,
      items: g.items.map((i) => ({ title: i.title, at: i.at, url: i.url })),
    })),
    moreGroups: digest.moreGroups,
    consoleUrl: digest.consoleUrl,
    at: digest.at,
  }
}

/** Everything a transport needs to send one message, whether an event or a digest. */
type Rendered = {
  eventHeader: string
  webhook: Record<string, unknown>
  text: string
}

async function dispatch(
  target: SendTarget,
  rendered: Rendered,
  fetchImpl: typeof fetch
): Promise<SendOutcome> {
  switch (target.kind) {
    case 'webhook': {
      const body = JSON.stringify(rendered.webhook)
      const headers: Record<string, string> = {
        'x-turbopanel-event': rendered.eventHeader,
        'user-agent': 'TurboPanel-Notifications/1',
      }
      if (target.signingSecret) {
        headers['x-turbopanel-signature'] = await signBody(target.signingSecret, body)
      }
      return await post(target.address, body, headers, fetchImpl)
    }
    case 'slack':
      return await post(target.address, JSON.stringify({ text: rendered.text }), {}, fetchImpl)
    case 'discord':
      return await post(target.address, JSON.stringify({ content: rendered.text }), {}, fetchImpl)
    case 'telegram': {
      const parsed = parseTelegramAddress(target.address)
      if (!parsed) return { ok: false, error: 'address_invalid' }
      return await post(
        `https://api.telegram.org/bot${parsed.token}/sendMessage`,
        JSON.stringify({
          chat_id: parsed.chatId,
          text: rendered.text,
          disable_web_page_preview: true,
        }),
        {},
        fetchImpl
      )
    }
    case 'email':
    case 'push':
      // Email rides the mailer queue and push the Expo service — neither is
      // a plain POST from here. The emitter routes them elsewhere; reaching
      // this arm is a wiring error, reported as such rather than thrown.
      return { ok: false, error: `unsupported_${target.kind}` }
  }
}

async function dispatchSafely(
  target: SendTarget,
  rendered: Rendered,
  fetchImpl: typeof fetch
): Promise<SendOutcome> {
  try {
    return await dispatch(target, rendered, fetchImpl)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : 'error' }
  }
}

/** Deliver one payload to one target. Resolves always; see the module contract. */
export function send(
  target: SendTarget,
  payload: DeliveryPayload,
  fetchImpl: typeof fetch = fetch
): Promise<SendOutcome> {
  return dispatchSafely(
    target,
    {
      eventHeader: payload.event,
      webhook: webhookBody(payload),
      text: renderText(payload),
    },
    fetchImpl
  )
}

/** Deliver one digest (the grouped events of a window) to one chat or webhook target. Resolves always. */
export function sendDigest(
  target: SendTarget,
  digest: DigestMessage,
  fetchImpl: typeof fetch = fetch
): Promise<SendOutcome> {
  return dispatchSafely(
    target,
    {
      eventHeader: 'digest',
      webhook: digestWebhookBody(digest),
      text: digestText(digest),
    },
    fetchImpl
  )
}
