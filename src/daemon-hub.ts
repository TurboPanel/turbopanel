import type { ServerAddresses } from './server-addresses.ts'


/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | {
    type: 'hello'
    from: 'instance' | 'daemon'
    at: string
    hostname?: string
    serverId?: string
    /** Daemon-only: stable host fingerprint for first-time server row lookup. */
    machineId?: string
  }
  | { type: 'ping'; id: string; at: string }
  | { type: 'pong'; id: string; at: string }
  | { type: 'echo'; payload: unknown; at: string }
  | { type: 'version'; commit: string; branch: string; at: string }
  | { type: 'command'; id: string; command: string; at: string }
  | {
    type: 'command-result'
    id: string
    exitCode: number
    stdout: string
    stderr: string
    at: string
  }
  | { type: 'addresses-request'; id: string; at: string }
  | {
    type: 'addresses-result'
    id: string
    addresses: ServerAddresses
    at: string
  }
  // Dev-only: push the instance host's current daemon build to an agent without
  // git. The tarball is streamed as base64 chunks (begin -> chunk* -> end), then
  // the daemon unpacks, caches, restarts, and replies with dev-sync-result.
  | {
    type: 'dev-sync-begin'
    id: string
    totalChunks: number
    totalBytes: number
    at: string
  }
  | { type: 'dev-sync-chunk'; id: string; index: number; data: string; at: string }
  | { type: 'dev-sync-end'; id: string; at: string }
  | { type: 'dev-sync-result'; id: string; ok: boolean; error?: string; at: string }
  // Dev/self-hosted: set the instance's Cloudflare tunnel token on the
  // co-located daemon, which (re)starts cloudflared to expose this instance.
  | { type: 'tunnel-token'; id: string; token: string; at: string }
  | { type: 'tunnel-token-result'; id: string; ok: boolean; error?: string; at: string }

export type DaemonSend = (
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
) => void

export type DaemonClose = () => void

export interface DaemonConnection {
  id: string
  connectedAt: string
  /** Short hostname reported by the daemon in its hello message. */
  hostname?: string
  /** Canonical server.id (uuidv7) for this physical server node. */
  serverId?: string
  /** Client IP as seen by Caddy (X-Real-IP), used to collapse duplicate reconnects. */
  remoteAddress?: string
  lastInboundAt: number
  send: DaemonSend
  close: DaemonClose
}

export type DaemonEvent =
  | { at: string; kind: 'connected'; daemonId: string }
  | { at: string; kind: 'disconnected'; daemonId: string }
  | {
    at: string
    kind: 'message'
    daemonId: string
    direction: 'in' | 'out'
    message: DaemonMessage
  }
  | { at: string; kind: 'broadcast'; sent: number; payload: unknown }

/** Result of a shell command dispatched to a daemon, tracked by command id. */
export interface CommandResult {
  id: string
  daemonId: string
  command: string
  status: 'pending' | 'done'
  exitCode?: number
  stdout?: string
  stderr?: string
  sentAt: string
  finishedAt?: string
}

const connections = new Map<string, DaemonConnection>()
const serverIdIndex = new Map<string, string>()
const events: DaemonEvent[] = []
const MAX_EVENTS = 100

const commands = new Map<string, CommandResult>()
const commandOrder: string[] = []
const MAX_COMMANDS = 100

const pendingAddresses = new Map<string, {
  daemonId: string
  resolve: (addresses: ServerAddresses) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

/** Correlated request/ack waiters (dev-sync, tunnel-token) keyed by request id. */
const pendingAcks = new Map<string, {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

const ADDRESSES_TIMEOUT_MS = 10_000
/** Drop sockets with no inbound traffic (pong, hello, etc.) for this long. */
export const DAEMON_STALE_MS = 45_000
/** Instance ping interval in deno-ws.ts — stale timeout must stay above this. */
export const DAEMON_PING_MS = 15_000

let nextId = 1

function recordEvent(event: DaemonEvent): void {
  events.push(event)
  if (events.length > MAX_EVENTS) events.shift()
}

export function recordDaemonConnected(daemonId: string): void {
  recordEvent({ at: new Date().toISOString(), kind: 'connected', daemonId })
}

export function recordDaemonDisconnected(daemonId: string): void {
  recordEvent({ at: new Date().toISOString(), kind: 'disconnected', daemonId })
}

export function recordDaemonMessage(
  daemonId: string,
  direction: 'in' | 'out',
  message: DaemonMessage,
): void {
  if (message.type === 'ping') return
  recordEvent({
    at: new Date().toISOString(),
    kind: 'message',
    daemonId,
    direction,
    message,
  })
}

export function recordDaemonBroadcast(sent: number, payload: unknown): void {
  recordEvent({
    at: new Date().toISOString(),
    kind: 'broadcast',
    sent,
    payload,
  })
}

export function listDaemonEvents(limit = 50): DaemonEvent[] {
  return events.slice(-limit)
}

export function registerDaemon(send: DaemonSend, close: DaemonClose): DaemonConnection {
  const id = `daemon-${nextId++}`
  const now = Date.now()
  const conn: DaemonConnection = {
    id,
    connectedAt: new Date().toISOString(),
    lastInboundAt: now,
    send,
    close,
  }
  connections.set(id, conn)
  recordDaemonConnected(id)
  return conn
}

export function unregisterDaemon(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  if (conn.serverId) {
    const indexed = serverIdIndex.get(conn.serverId)
    if (indexed === id) serverIdIndex.delete(conn.serverId)
  }
  connections.delete(id)
  recordDaemonDisconnected(id)
  try {
    conn.close()
  } catch {
    // Socket may already be closed.
  }
}

export function touchDaemonInbound(id: string): void {
  const conn = connections.get(id)
  if (conn) conn.lastInboundAt = Date.now()
}

export function setDaemonHostname(id: string, hostname: string): void {
  const conn = connections.get(id)
  if (!conn) return
  const trimmed = hostname.trim()
  if (!trimmed) return
  conn.hostname = trimmed
  evictDuplicateDaemons(id, {
    hostname: trimmed,
    serverId: conn.serverId,
    remoteAddress: conn.remoteAddress,
  })
}

export function setDaemonServerId(id: string, serverId: string): string {
  const conn = connections.get(id)
  if (!conn) return id
  const trimmed = serverId.trim()
  if (!trimmed) return id

  const existingId = serverIdIndex.get(trimmed)
  if (existingId && existingId !== id) {
    const existing = connections.get(existingId)
    const incoming = conn
    if (existing) {
      existing.send = incoming.send
      existing.close = incoming.close
      existing.lastInboundAt = Date.now()
      existing.hostname = incoming.hostname ?? existing.hostname
      existing.remoteAddress = incoming.remoteAddress ?? existing.remoteAddress
      connections.delete(id)
      return existingId
    }
  }

  if (conn.serverId && conn.serverId !== trimmed) {
    const indexed = serverIdIndex.get(conn.serverId)
    if (indexed === id) serverIdIndex.delete(conn.serverId)
  }
  conn.serverId = trimmed
  serverIdIndex.set(trimmed, id)
  return id
}

export function setDaemonRemoteAddress(id: string, remoteAddress: string): void {
  const conn = connections.get(id)
  if (!conn) return
  const trimmed = remoteAddress.trim()
  if (!trimmed) return
  conn.remoteAddress = trimmed
}

/**
 * When a daemon identifies itself, close any older sockets for the same host.
 * Reconnects were registering a new daemon-N without the previous onClose firing.
 */
export function evictDuplicateDaemons(
  keepId: string,
  identity: { hostname?: string; serverId?: string; remoteAddress?: string },
): string[] {
  const hostname = identity.hostname?.trim()
  const serverId = identity.serverId?.trim()
  const remoteAddress = identity.remoteAddress?.trim()
  if (!hostname && !serverId && !remoteAddress) return []

  const evicted: string[] = []
  for (const [id, conn] of connections.entries()) {
    if (id === keepId) continue
    const sameHost = hostname && conn.hostname === hostname
    const sameServer = serverId && conn.serverId === serverId
    const sameAddr = remoteAddress && conn.remoteAddress === remoteAddress
    if (sameHost || sameServer || sameAddr) {
      unregisterDaemon(id)
      evicted.push(id)
    }
  }
  return evicted
}

/** Remove zombie sockets that stopped responding (no inbound messages). */
export function pruneStaleDaemons(maxIdleMs = DAEMON_STALE_MS): string[] {
  const now = Date.now()
  const pruned: string[] = []
  for (const [id, conn] of connections.entries()) {
    const idleMs = now - conn.lastInboundAt
    if (idleMs >= maxIdleMs) {
      unregisterDaemon(id)
      pruned.push(id)
    }
  }
  return pruned
}

export function listDaemonConnections(): Omit<DaemonConnection, 'send' | 'close'>[] {
  return [...connections.values()].map(({
    id,
    connectedAt,
    hostname,
    serverId,
    remoteAddress,
    lastInboundAt,
  }) => ({
    id,
    connectedAt,
    hostname: hostname ?? null,
    serverId: serverId ?? null,
    remoteAddress: remoteAddress && remoteAddress !== '__direct__'
      ? remoteAddress
      : null,
    lastInboundAt,
  }))
}

/**
 * The connection id of the co-located daemon (one that dialed the Unix socket
 * directly, with no Caddy/X-Real-IP hop), or null if none is connected. Used to
 * target the instance's own Cloudflare tunnel token.
 */
export function getColocatedDaemonId(): string | null {
  for (const conn of connections.values()) {
    if (conn.remoteAddress === '__direct__') return conn.id
  }
  return null
}

/** Canonical server.id for the co-located daemon, when connected. */
export function getColocatedDaemonServerId(): string | null {
  for (const conn of connections.values()) {
    if (conn.remoteAddress === '__direct__' && conn.serverId) {
      return conn.serverId
    }
  }
  return null
}

export function sendToDaemon(id: string, message: DaemonMessage): boolean {
  const conn = connections.get(id)
  if (!conn) return false
  recordDaemonMessage(id, 'out', message)
  conn.send(JSON.stringify(message))
  return true
}

/**
 * Send a shell command to a connected daemon and start tracking its result.
 * Returns the generated command id, or `null` if the daemon is not connected.
 */
export function dispatchCommand(
  daemonId: string,
  command: string,
): string | null {
  const conn = connections.get(daemonId)
  if (!conn) return null

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const message: DaemonMessage = { type: 'command', id, command, at: now }

  commands.set(id, { id, daemonId, command, status: 'pending', sentAt: now })
  commandOrder.push(id)
  while (commandOrder.length > MAX_COMMANDS) {
    const old = commandOrder.shift()
    if (old) commands.delete(old)
  }

  recordDaemonMessage(daemonId, 'out', message)
  conn.send(JSON.stringify(message))
  return id
}

/** Record a command-result message coming back from a daemon. */
export function recordCommandResult(
  message: Extract<DaemonMessage, { type: 'command-result' }>,
): void {
  const entry = commands.get(message.id)
  if (!entry) return
  entry.status = 'done'
  entry.exitCode = message.exitCode
  entry.stdout = message.stdout
  entry.stderr = message.stderr
  entry.finishedAt = message.at
}

export function listCommandResults(limit = 50): CommandResult[] {
  return commandOrder
    .slice(-limit)
    .map((id) => commands.get(id))
    .filter((entry): entry is CommandResult => entry !== undefined)
}

/** Ask a connected daemon for its network addresses and wait for the reply. */
export function requestDaemonAddresses(
  daemonId: string,
  timeoutMs = ADDRESSES_TIMEOUT_MS,
): Promise<ServerAddresses> {
  const conn = connections.get(daemonId)
  if (!conn) {
    return Promise.reject(new Error('daemon not connected'))
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingAddresses.delete(id)
      reject(new Error('timeout waiting for addresses'))
    }, timeoutMs)

    pendingAddresses.set(id, { daemonId, resolve, reject, timer })

    const message: DaemonMessage = {
      type: 'addresses-request',
      id,
      at: new Date().toISOString(),
    }
    recordDaemonMessage(daemonId, 'out', message)
    conn.send(JSON.stringify(message))
  })
}

export function recordAddressesResult(
  message: Extract<DaemonMessage, { type: 'addresses-result' }>,
): void {
  const pending = pendingAddresses.get(message.id)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingAddresses.delete(message.id)
  pending.resolve(message.addresses)
}

/**
 * Wait for a daemon to acknowledge a correlated request (dev-sync / tunnel-token).
 * Resolves on `{ ok: true }`, rejects on `{ ok: false }` or timeout.
 */
export function awaitDaemonAck(
  id: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(id)
      reject(new Error('timeout waiting for daemon acknowledgement'))
    }, timeoutMs)
    pendingAcks.set(id, { resolve, reject, timer })
  })
}

/** Resolve/reject a pending ack from a daemon result message. */
export function recordDaemonAck(id: string, ok: boolean, error?: string): void {
  const pending = pendingAcks.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingAcks.delete(id)
  if (ok) pending.resolve()
  else pending.reject(new Error(error || 'daemon reported failure'))
}

export function broadcastToDaemons(message: DaemonMessage): number {
  const payload = JSON.stringify(message)
  let sent = 0
  for (const conn of connections.values()) {
    recordDaemonMessage(conn.id, 'out', message)
    conn.send(payload)
    sent++
  }
  return sent
}

export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage
  } catch {
    return null
  }
}
