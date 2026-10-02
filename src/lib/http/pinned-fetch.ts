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

export type PinnedConn = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): void
}

export type PinnedTarget = {
  address: string
  port: number
  serverName: string
}

export type PinnedConnect = (target: PinnedTarget) => Promise<PinnedConn>

export const MAX_HEADER_BYTES = 64 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type DenoNet = {
  connect(opts: { hostname: string; port: number }): Promise<{
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    close(): void
  }>
  startTls(conn: unknown, opts: { hostname: string }): Promise<PinnedConn>
}

/** The Deno transport, or `null` where there is none (Workers, browsers). */
export function denoPinnedConnect(): PinnedConnect | null {
  const deno = (globalThis as unknown as { Deno?: Partial<DenoNet> }).Deno
  if (typeof deno?.connect !== 'function' || typeof deno.startTls !== 'function') return null
  const net = deno as DenoNet
  return async ({ address, port, serverName }) => {
    const tcp = await net.connect({ hostname: address, port })
    try {
      return await net.startTls(tcp, { hostname: serverName })
    } catch (error) {
      tcp.close()
      throw error
    }
  }
}

/** Pulls bytes off a stream with a push-back buffer, for the header/chunk parsing. */
class ByteReader {
  private buffer = new Uint8Array(0)
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  private async fill(): Promise<boolean> {
    const { done, value } = await this.reader.read()
    if (done) return false
    const merged = new Uint8Array(this.buffer.length + value.length)
    merged.set(this.buffer)
    merged.set(value, this.buffer.length)
    this.buffer = merged
    return true
  }

  /** Bytes up to (excluding) `delimiter`, consuming it; `null` at a clean end. */
  async readUntil(delimiter: Uint8Array, limit: number, from = 0): Promise<Uint8Array | null> {
    const at = indexOf(this.buffer, delimiter, from)
    if (at >= 0) {
      const head = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + delimiter.length)
      return head
    }
    if (this.buffer.length > limit) {
      throw new Error('pinned fetch: header section too large')
    }
    const next = Math.max(0, this.buffer.length - delimiter.length + 1)
    if (await this.fill()) return this.readUntil(delimiter, limit, next)
    if (this.buffer.length === 0) return null
    throw new Error('pinned fetch: connection closed mid-message')
  }

  /** Up to `max` bytes (at least one), or `null` at the end of the stream. */
  async readSome(max: number): Promise<Uint8Array | null> {
    if (this.buffer.length === 0 && !(await this.fill())) return null
    const chunk = this.buffer.slice(0, max)
    this.buffer = this.buffer.slice(chunk.length)
    return chunk
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
  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) {
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

/** Skip trailer lines up to and including the blank line that ends the body. */
async function skipTrailers(reader: ByteReader): Promise<void> {
  const trailer = await reader.readUntil(CRLF, MAX_HEADER_BYTES)
  if (!trailer?.length) return
  await skipTrailers(reader)
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
  let failure: unknown = new Error('pinned fetch: no address to connect to')
  const connected = await firstSequential(options.addresses, async (address) => {
    try {
      return await options.connect({ address, port, serverName })
    } catch (error) {
      failure = error
      return undefined
    }
  })
  if (connected) return connected
  throw failure
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
  const conn = await connectFirst(options, Number(url.port || 443), hostname)
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

async function readHead(reader: ByteReader): Promise<ParsedHead> {
  const raw = await reader.readUntil(HEADER_END, MAX_HEADER_BYTES)
  if (raw === null) throw new Error('pinned fetch: connection closed before a response')
  const head = parseHead(raw)
  // A 1xx interim response (we send no Expect, but be tolerant) is skipped.
  return head.status >= 200 ? head : readHead(reader)
}
