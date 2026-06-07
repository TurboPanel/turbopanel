import type { ServerAddresses } from './server-addresses.ts'

import { agentDebugLog } from './debug-agent-log.ts'

/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | {
    type: 'hello'
    from: 'instance' | 'daemon'
    at: string
    hostname?: string
    nodeId?: string
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

export type DaemonSend = (
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
) => void

export type DaemonClose = () => void

export interface DaemonConnection {
  id: string
  connectedAt: string
  /** Short hostname reported by the daemon in its hello message. */
  hostname?: string
  /** Stable host identity (e.g. /etc/machine-id) for deduplicating reconnects. */
  nodeId?: string
  /** Client IP as seen by Caddy (X-Real-IP), used to collapse duplicate reconnects. */
  remoteAddress?: string
  /** Whether a background `hostname` probe was dispatched for legacy agents. */
  hostnameProbeSent?: boolean
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

const ADDRESSES_TIMEOUT_MS = 10_000
/** Drop sockets with no inbound traffic (pong, hello, etc.) for this long. */
export const DAEMON_STALE_MS = 45_000
/** Sockets that never got an identity address (legacy zombie reconnects). */
const STALE_NO_ADDRESS_MS = 15_000
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
    nodeId: conn.nodeId,
    remoteAddress: conn.remoteAddress,
  })
}

const HOSTNAME_PROBE_CMD = 'hostname'

/**
 * Legacy agents may not send hostname in hello. Run `hostname` once per socket.
 */
export function probeDaemonHostname(daemonId: string): void {
  const conn = connections.get(daemonId)
  if (!conn || conn.hostname || conn.hostnameProbeSent) return
  conn.hostnameProbeSent = true
  dispatchCommand(daemonId, HOSTNAME_PROBE_CMD)
}

/** Probe any connected socket that still lacks a hostname (e.g. after a hot reload). */
export function probeMissingHostnames(): void {
  for (const [id, conn] of connections.entries()) {
    if (!conn.hostname) probeDaemonHostname(id)
  }
}

export function setDaemonNodeId(id: string, nodeId: string): void {
  const conn = connections.get(id)
  if (!conn) return
  const trimmed = nodeId.trim()
  if (!trimmed) return
  conn.nodeId = trimmed
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
  identity: { hostname?: string; nodeId?: string; remoteAddress?: string },
): string[] {
  const hostname = identity.hostname?.trim()
  const nodeId = identity.nodeId?.trim()
  const remoteAddress = identity.remoteAddress?.trim()
  if (!hostname && !nodeId && !remoteAddress) return []

  const evicted: string[] = []
  for (const [id, conn] of connections.entries()) {
    if (id === keepId) continue
    const sameHost = hostname && conn.hostname === hostname
    const sameNode = nodeId && conn.nodeId === nodeId
    const sameAddr = remoteAddress && conn.remoteAddress === remoteAddress
    if (sameHost || sameNode || sameAddr) {
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
    const idleLimit = conn.remoteAddress ? maxIdleMs : STALE_NO_ADDRESS_MS
    if (idleMs >= idleLimit) {
      // #region agent log
      agentDebugLog('daemon-hub.ts:pruneStaleDaemons', 'pruning stale daemon', {
        id,
        hostname: conn.hostname ?? null,
        remoteAddress: conn.remoteAddress ?? null,
        idleMs,
        idleLimit,
      }, 'H1')
      // #endregion
      unregisterDaemon(id)
      pruned.push(id)
    }
  }
  return pruned
}

export function listDaemonConnections(): Omit<DaemonConnection, 'send' | 'close'>[] {
  return [...connections.values()].map(({ id, connectedAt, hostname, nodeId, remoteAddress }) => ({
    id,
    connectedAt,
    hostname: hostname ?? null,
    nodeId: nodeId ?? null,
    remoteAddress: remoteAddress && remoteAddress !== '__direct__'
      ? remoteAddress
      : null,
  }))
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

  if (
    entry.command.trim() === HOSTNAME_PROBE_CMD &&
    message.exitCode === 0
  ) {
    const host = message.stdout.trim().split('\n')[0]?.trim()
    if (host) setDaemonHostname(entry.daemonId, host)
  }
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
