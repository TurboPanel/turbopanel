/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | { type: 'hello'; from: 'instance' | 'daemon'; at: string }
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

export type DaemonSend = (
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
) => void

export interface DaemonConnection {
  id: string
  connectedAt: string
  send: DaemonSend
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

export function registerDaemon(send: DaemonSend): DaemonConnection {
  const id = `daemon-${nextId++}`
  const conn: DaemonConnection = {
    id,
    connectedAt: new Date().toISOString(),
    send,
  }
  connections.set(id, conn)
  recordDaemonConnected(id)
  return conn
}

export function unregisterDaemon(id: string): void {
  if (connections.delete(id)) recordDaemonDisconnected(id)
}

export function listDaemonConnections(): Omit<DaemonConnection, 'send'>[] {
  return [...connections.values()].map(({ id, connectedAt }) => ({
    id,
    connectedAt,
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
}

export function listCommandResults(limit = 50): CommandResult[] {
  return commandOrder
    .slice(-limit)
    .map((id) => commands.get(id))
    .filter((entry): entry is CommandResult => entry !== undefined)
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
