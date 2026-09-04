/**
 * Shared bounded request-body reading, used by every surface that must read a
 * body before the caller is authenticated (daemon REST, the webhook gate,
 * public auth routes): the daemon API routes module first, everyone else
 * since.
 *
 * A `Content-Length` precheck is a fast rejection, never the only guard — the
 * header is the sender's claim, not a fact (chunked transfer encodes no
 * length at all). The streaming reader below aborts as soon as the accumulated
 * byte count crosses the budget, so an oversized upload is never fully
 * buffered regardless of whether `Content-Length` was present, truthful, or
 * absent.
 */

import type { Context } from 'hono'

/**
 * `Content-Length` fast-rejection. Returns a `413` `Response`, or `null` when
 * the header is absent or within budget. Cheaper than reading the stream, but
 * never sufficient on its own — the header is untrusted.
 */
export function rejectIfContentLengthTooLarge(
  c: Context,
  maxBytes: number,
): Response | null {
  const declaredLength = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return c.json({ ok: false, error: 'request body too large' }, 413)
  }
  return null
}

/** True when the declared `Content-Length` exceeds `maxBytes`. No Response built. */
export function contentLengthExceeds(c: Context, maxBytes: number): boolean {
  const declaredLength = Number(c.req.header('content-length') ?? '')
  return Number.isFinite(declaredLength) && declaredLength > maxBytes
}

/**
 * Stream the request body, aborting the read as soon as the accumulated byte
 * count exceeds `maxBytes` — the oversized remainder of the body is never
 * pulled into memory. Works whether or not `Content-Length` was sent (a
 * chunked-encoded upload has none).
 */
export async function readBodyWithByteLimit(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const stream = c.req.raw.body
  if (!stream) {
    return { ok: true, bytes: new Uint8Array(0) }
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged }
}

/**
 * `Content-Length` precheck + streaming byte budget, decoded as text. Returns
 * the body text or a `413` `Response` when the upload exceeds `maxBytes`.
 */
export async function readBoundedBodyText(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const tooLarge = rejectIfContentLengthTooLarge(c, maxBytes)
  if (tooLarge) return { ok: false, response: tooLarge }
  const bodyRead = await readBodyWithByteLimit(c, maxBytes)
  if (!bodyRead.ok) {
    return {
      ok: false,
      response: c.json({ ok: false, error: 'request body too large' }, 413),
    }
  }
  return { ok: true, text: new TextDecoder().decode(bodyRead.bytes) }
}

/**
 * `Content-Length` precheck + streaming byte budget, kept as raw bytes (no
 * text decode). Used by callers that verify a signature over the exact bytes
 * (the webhook gate) before any parse.
 */
export async function readBoundedBodyBytes(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (contentLengthExceeds(c, maxBytes)) return { ok: false }
  return await readBodyWithByteLimit(c, maxBytes)
}

export type BoundedJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: 'too-large' | 'malformed' }

/**
 * Bounded read + JSON parse in one step, for public auth-style surfaces that
 * must charge a rate-limit bucket on failure (see `client/authn/http.ts`).
 * Distinguishes "too large" from "malformed" so callers can answer 413 vs 400.
 */
export async function readBoundedJson(
  c: Context,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  if (contentLengthExceeds(c, maxBytes)) return { ok: false, reason: 'too-large' }
  const read = await readBodyWithByteLimit(c, maxBytes)
  if (!read.ok) return { ok: false, reason: 'too-large' }
  const text = new TextDecoder().decode(read.bytes)
  if (!text.trim()) return { ok: false, reason: 'malformed' }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
