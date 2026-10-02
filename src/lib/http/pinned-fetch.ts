/**
 * An HTTPS request whose TCP connection is pinned to an address the caller
 * already judged, with the URL's host name kept for the TLS handshake (SNI
 * and certificate check) and the `Host` header.
 *
 * Why this exists: `fetch` resolves the name itself, so a check that resolved
 * the name first leaves a window in which a hostile zone answers a public
 * address to the check and a private one (loopback, the metadata endpoint) to
 * the fetch. Deno's `fetch` has no hook to hand it an address, so on the Deno
 * instance the request is made here instead: `Deno.connect` to the validated
 * IP, `Deno.startTls` with the real host name, then a deliberately small
 * HTTP/1.1 exchange (one request, `Connection: close`, identity or
 * gzip/deflate bodies, content-length / chunked / until-close framing).
 *
 * Workers cannot do this (no raw sockets in `fetch`, no resolver); callers
 * fall back to `fetch` there. See `git/forge-url.ts` for the per-runtime story.
 *
 * Everything runtime-specific is behind {@link PinnedConnect}, so the HTTP
 * handling is tested with fakes and no network.
 */

import { firstSequential } from '../sequential.ts'
import { abortable } from './abortable.ts'

export type PinnedConn = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): void
}

export type PinnedTarget = {
  address: string
  port: number
  serverName: string
  /** The caller's deadline; a connect or handshake still pending when it fires is abandoned. */
  signal?: AbortSignal
}

export type PinnedConnect = (target: PinnedTarget) => Promise<PinnedConn>

export const MAX_HEADER_BYTES = 64 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type DenoNet = {
  connect(opts: { hostname: string; port: number; signal?: AbortSignal }): Promise<PinnedConn>
  startTls(conn: unknown, opts: { hostname: string }): Promise<PinnedConn>
}

function closeQuietly(conn: PinnedConn): void {
  try {
    conn.close()
  } catch {
    // already closed, or owned by the TLS layer now
  }
}

/**
 * The TCP connect and the TLS handshake, each abandoned (and its socket
 * closed) when `signal` fires — a peer that accepts the connection and never
 * sends a ServerHello must not outlive the caller's deadline.
 */
export function pinnedConnectVia(net: DenoNet): PinnedConnect {
  return async ({ address, port, serverName, signal }) => {
    const tcp = await abortable(
      net.connect({ hostname: address, port, signal }),
      signal,
      closeQuietly
    )
    try {
      return await abortable(net.startTls(tcp, { hostname: serverName }), signal, closeQuietly)
    } catch (error) {
      closeQuietly(tcp)
      throw error
    }
  }
}

/** The Deno transport, or `null` where there is none (Workers, browsers). */
export function denoPinnedConnect(): PinnedConnect | null {
  const deno = (globalThis as unknown as { Deno?: Partial<DenoNet> }).Deno
  if (typeof deno?.connect !== 'function' || typeof deno.startTls !== 'function') return null
  return pinnedConnectVia(deno as DenoNet)
}

/**
 * Pulls bytes off a stream with a push-back buffer, for the header/chunk
 * parsing. Consumed bytes are skipped by moving `start`, not by copying the
 * rest of the buffer on every read; the buffer is only rebuilt when a new
 * network read has to be appended to unread bytes. Returned pieces are views
 * of buffers that are never written to again, so they stay valid.
 */
class ByteReader {
  private buffer: Uint8Array = new Uint8Array(0)
  private start = 0
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  private get unread(): number {
    return this.buffer.length - this.start
  }

  private async fill(): Promise<boolean> {
    const { done, value } = await this.reader.read()
    if (done) return false
    if (this.unread === 0) {
      this.buffer = value
    } else {
      const merged = new Uint8Array(this.unread + value.length)
      merged.set(this.buffer.subarray(this.start))
      merged.set(value, this.unread)
      this.buffer = merged
    }
    this.start = 0
    return true
  }

  private take(length: number, skip = 0): Uint8Array {
    const piece = this.buffer.subarray(this.start, this.start + length)
    this.start += length + skip
    return piece
  }

  /** Bytes up to (excluding) `delimiter`, consuming it; `null` at a clean end. */
  async readUntil(delimiter: Uint8Array, limit: number, from = 0): Promise<Uint8Array | null> {
    const at = indexOf(this.buffer, delimiter, this.start + from)
    if (at >= 0) return this.take(at - this.start, delimiter.length)
    if (this.unread > limit) {
      throw new Error('pinned fetch: header section too large')
    }
    const next = Math.max(0, this.unread - delimiter.length + 1)
    if (await this.fill()) return this.readUntil(delimiter, limit, next)
    if (this.unread === 0) return null
    throw new Error('pinned fetch: connection closed mid-message')
  }

  /** Up to `max` bytes (at least one), or `null` at the end of the stream. */
  async readSome(max: number): Promise<Uint8Array | null> {
    if (this.unread === 0 && !(await this.fill())) return null
    return this.take(Math.min(max, this.unread))
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {})
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

const CRLF = encoder.encode('\r\n')
const HEADER_END = encoder.encode('\r\n\r\n')

/** Headers the transport owns; a caller-supplied value would desync the framing. */
const OWNED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'upgrade',
  'expect',
  'te',
])

async function serializeRequest(request: Request, url: URL): Promise<Uint8Array> {
  const body = new Uint8Array(await request.arrayBuffer())
  const target = `${url.pathname}${url.search}`
  const lines = [`${request.method} ${target} HTTP/1.1`, `Host: ${url.host}`]
  for (const [name, value] of request.headers) {
    if (!OWNED_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${value}`)
  }
  lines.push('Connection: close', 'Accept-Encoding: gzip, deflate')
  if (body.length > 0 || !['GET', 'HEAD'].includes(request.method)) {
    lines.push(`Content-Length: ${body.length}`)
  }
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

type ParsedHead = { status: number; statusText: string; headers: Headers }

function parseHead(raw: Uint8Array): ParsedHead {
  const [statusLine = '', ...headerLines] = decoder.decode(raw).split('\r\n')
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine)
  if (!match) throw new Error('pinned fetch: malformed status line')
  const headers = new Headers()
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error('pinned fetch: malformed header')
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', headers }
}

type Framing =
  | { kind: 'none' }
  | { kind: 'chunked' }
  | {
      kind: 'length'
      length: number
    }
  | {
      kind: 'close'
    }

function framingFor(method: string, head: ParsedHead): Framing {
  const { status, headers } = head
  if (method === 'HEAD' || status === 204 || status === 304) {
    return { kind: 'none' }
  }
  const transferEncoding = headers.get('transfer-encoding')
  if (transferEncoding !== null) {
    // RFC 9112 6.3: only a final `chunked` coding frames the body, and this
    // client decodes no other transfer coding, so `chunked` must be the whole
    // list (`xchunked`, `chunked, gzip` and `gzip, chunked` are all refused).
    // Content-Length is never a fallback once Transfer-Encoding is present.
    const codings = transferEncoding.split(',').map((coding) => coding.trim().toLowerCase())
    if (codings.length !== 1 || codings[0] !== 'chunked') {
      throw new Error(`pinned fetch: unsupported transfer-encoding ${transferEncoding}`)
    }
    return { kind: 'chunked' }
  }
  const declared = headers.get('content-length')
  if (declared === null) return { kind: 'close' }
  if (!/^\d+$/.test(declared)) {
    throw new Error('pinned fetch: bad content-length')
  }
  return { kind: 'length', length: Number(declared) }
}

/** Yields the next piece of the body, or `null` once it has ended. */
type BodyPull = () => Promise<Uint8Array | null>

function lengthPull(reader: ByteReader, length: number): BodyPull {
  let remaining = length
  return async () => {
    if (remaining === 0) return null
    const chunk = await reader.readSome(remaining)
    if (!chunk) throw new Error('pinned fetch: connection closed before the body ended')
    remaining -= chunk.length
    return chunk
  }
}

function closePull(reader: ByteReader): BodyPull {
  return () => reader.readSome(64 * 1024)
}

/** Trailer lines a chunked body may carry; their bytes share {@link MAX_HEADER_BYTES}. */
export const MAX_TRAILER_LINES = 64
/** Interim 1xx responses tolerated ahead of the final one. */
export const MAX_INTERIM_RESPONSES = 8

/** `count` slots for {@link firstSequential}: a bounded, ordered retry without a loop. */
function attempts(count: number): undefined[] {
  return Array.from({ length: count }, () => undefined)
}

/**
 * Skip trailer lines up to and including the blank line that ends the body,
 * within {@link MAX_TRAILER_LINES} lines and {@link MAX_HEADER_BYTES} bytes.
 */
async function skipTrailers(reader: ByteReader): Promise<void> {
  let budget = MAX_HEADER_BYTES
  const ended = await firstSequential(attempts(MAX_TRAILER_LINES), async () => {
    const trailer = await reader.readUntil(CRLF, budget)
    if (!trailer?.length) return true
    budget -= trailer.length + CRLF.length
    if (budget < 0) throw new Error('pinned fetch: trailer section too large')
    return undefined
  })
  if (!ended) throw new Error('pinned fetch: too many trailer lines')
}

async function readChunkSize(reader: ByteReader): Promise<number> {
  const sizeLine = await reader.readUntil(CRLF, 1024)
  if (sizeLine === null) {
    throw new Error('pinned fetch: connection closed inside a chunked body')
  }
  const hex = decoder.decode(sizeLine).split(';')[0]!.trim()
  if (!/^[\da-fA-F]+$/.test(hex)) throw new Error('pinned fetch: bad chunk size')
  return Number.parseInt(hex, 16)
}

function chunkedPull(reader: ByteReader): BodyPull {
  let inChunk = 0
  let finished = false
  let afterData = false
  const pull: BodyPull = async () => {
    if (finished) return null
    if (inChunk > 0) {
      const chunk = await reader.readSome(inChunk)
      if (!chunk) throw new Error('pinned fetch: connection closed before the chunk ended')
      inChunk -= chunk.length
      afterData = true
      return chunk
    }
    if (afterData) {
      const end = await reader.readUntil(CRLF, 2)
      if (end?.length !== 0) throw new Error('pinned fetch: bad chunk terminator')
      afterData = false
    }
    inChunk = await readChunkSize(reader)
    if (inChunk === 0) {
      finished = true
      await skipTrailers(reader)
      return null
    }
    return pull()
  }
  return pull
}

function bodySource(framing: Exclude<Framing, { kind: 'none' }>, reader: ByteReader): BodyPull {
  if (framing.kind === 'chunked') return chunkedPull(reader)
  if (framing.kind === 'length') return lengthPull(reader, framing.length)
  return closePull(reader)
}

function bodyStream(
  framing: Framing,
  reader: ByteReader,
  conn: PinnedConn
): ReadableStream<Uint8Array> | null {
  if (framing.kind === 'none') {
    conn.close()
    return null
  }
  const nextPiece = bodySource(framing, reader)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const piece = await nextPiece()
        if (piece === null) {
          conn.close()
          controller.close()
        } else {
          controller.enqueue(piece)
        }
      } catch (error) {
        conn.close()
        controller.error(error)
      }
    },
    async cancel() {
      conn.close()
      await reader.cancel()
    },
  })
}

function decodeContentEncoding(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers
): ReadableStream<Uint8Array> | null {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase()
  if (!encoding || encoding === 'identity') return body
  if (encoding !== 'gzip' && encoding !== 'deflate') {
    throw new Error(`pinned fetch: unsupported content-encoding ${encoding}`)
  }
  headers.delete('content-encoding')
  headers.delete('content-length')
  if (!body) return body
  return body.pipeThrough(
    new DecompressionStream(encoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  )
}

export type PinnedFetchOptions = {
  /** Validated addresses to try, in order. */
  addresses: readonly string[]
  connect: PinnedConnect
  signal?: AbortSignal
}

async function connectFirst(
  options: PinnedFetchOptions,
  port: number,
  serverName: string
): Promise<PinnedConn> {
  const { signal } = options
  let failure: unknown = new Error('pinned fetch: no address to connect to')
  // One deadline for every address: an abort stops the walk instead of
  // counting as this address's failure and moving on to the next.
  const connected = await firstSequential(options.addresses, async (address) => {
    signal?.throwIfAborted()
    try {
      return await abortable(
        options.connect({ address, port, serverName, signal }),
        signal,
        closeQuietly
      )
    } catch (error) {
      signal?.throwIfAborted()
      failure = error
      return undefined
    }
  })
  if (connected) return connected
  throw failure
}

/** `close()` that is safe to call from the abort, end-of-body, cancel and error paths alike. */
function idempotentClose(conn: PinnedConn): PinnedConn {
  let closed = false
  return {
    readable: conn.readable,
    writable: conn.writable,
    close() {
      if (closed) return
      closed = true
      try {
        conn.close()
      } catch {
        // already closed by the runtime
      }
    },
  }
}

/**
 * Send `request` over a connection to one of `options.addresses`, never
 * resolving the URL's host. `request` must be `https:`; redirects are the
 * caller's business (the response is returned as-is).
 */
export async function pinnedFetch(
  request: Request,
  options: PinnedFetchOptions
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:') throw new Error('pinned fetch: https only')
  const bytes = await serializeRequest(request, url)
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  options.signal?.throwIfAborted()
  const conn = idempotentClose(await connectFirst(options, Number(url.port || 443), hostname))
  const onAbort = () => conn.close()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const writer = conn.writable.getWriter()
    await writer.write(bytes)
    writer.releaseLock()
    const reader = new ByteReader(conn.readable)
    const head = await readHead(reader)
    const framing = framingFor(request.method, head)
    const body = decodeContentEncoding(bodyStream(framing, reader, conn), head.headers)
    return new Response(body, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    })
  } catch (error) {
    conn.close()
    throw error
  }
}

/**
 * The final response head. Up to {@link MAX_INTERIM_RESPONSES} 1xx interim
 * responses ahead of it (we send no Expect, but be tolerant) are skipped.
 */
async function readHead(reader: ByteReader): Promise<ParsedHead> {
  const head = await firstSequential(attempts(MAX_INTERIM_RESPONSES + 1), async () => {
    const raw = await reader.readUntil(HEADER_END, MAX_HEADER_BYTES)
    if (raw === null) throw new Error('pinned fetch: connection closed before a response')
    const parsed = parseHead(raw)
    return parsed.status >= 200 ? parsed : undefined
  })
  if (!head) throw new Error('pinned fetch: too many interim responses')
  return head
}
