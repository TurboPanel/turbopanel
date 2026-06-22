import type { ServerAddresses } from '../../server-addresses.ts'

/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
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
  | { type: 'update'; id: string; updateUrl: string; at: string }
  | { type: 'update-result'; id: string; ok: boolean; error?: string; at: string }

/** Drop sockets with no inbound traffic (pong, results, etc.) for this long. */
export const DAEMON_STALE_MS = 45_000
/** Instance ping interval in deno-ws.ts — stale timeout must stay above this. */
export const DAEMON_PING_MS = 15_000
/** Message types accepted from daemons after authentication succeeds. */
export const DAEMON_INBOUND_ALLOWED = new Set([
  'ping',
  'pong',
  'command-result',
  'addresses-result',
  'dev-sync-result',
  'tunnel-token-result',
  'update-result',
] as const)

/** Per-outbox-entry identity for queue send/ack/resend semantics. */
export type OutboxDeliveryId = string

/** Correlation/idempotency key shared by all frames in a multi-message request. */
export type OutboundRequestId = string

type OutboundEnvelopeBase = {
  /** Unique outbox entry key; distinct for every queued delivery. */
  deliveryId: OutboxDeliveryId
  /** Correlates multi-frame requests (e.g. dev-sync chunks) and inbound acks. */
  requestId: OutboundRequestId
  at: string
}

/** Cell-internal outbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonOutboundEnvelope =
  | (OutboundEnvelopeBase & { kind: 'command'; command: string })
  | (OutboundEnvelopeBase & { kind: 'addresses-request' })
  | (OutboundEnvelopeBase & {
    kind: 'dev-sync'
    phase: 'begin'
    totalChunks: number
    totalBytes: number
  })
  | (OutboundEnvelopeBase & {
    kind: 'dev-sync'
    phase: 'chunk'
    index: number
    data: string
  })
  | (OutboundEnvelopeBase & { kind: 'dev-sync'; phase: 'end' })
  | (OutboundEnvelopeBase & { kind: 'tunnel-token'; token: string })
  | (OutboundEnvelopeBase & { kind: 'update'; updateUrl: string })
  | (OutboundEnvelopeBase & { kind: 'ping' })
  | (OutboundEnvelopeBase & { kind: 'echo'; payload: unknown })

/** Cell-internal inbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonInboundEnvelope =
  | { kind: 'pong'; requestId: string; at: string }
  | { kind: 'addresses-result'; requestId: string; at: string; addresses: ServerAddresses }
  | {
    kind: 'command-result'
    requestId: string
    at: string
    exitCode: number
    stdout: string
    stderr: string
  }
  | { kind: 'dev-sync-result'; requestId: string; at: string; ok: boolean; error?: string }
  | { kind: 'tunnel-token-result'; requestId: string; at: string; ok: boolean; error?: string }
  | { kind: 'update-result'; requestId: string; at: string; ok: boolean; error?: string }

export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage
  } catch {
    return null
  }
}

export function wireMessageToInboundEnvelope(
  msg: DaemonMessage,
): DaemonInboundEnvelope | null {
  switch (msg.type) {
    case 'pong':
      return { kind: 'pong', requestId: msg.id, at: msg.at }
    case 'addresses-result':
      return {
        kind: 'addresses-result',
        requestId: msg.id,
        at: msg.at,
        addresses: msg.addresses,
      }
    case 'command-result':
      return {
        kind: 'command-result',
        requestId: msg.id,
        at: msg.at,
        exitCode: msg.exitCode,
        stdout: msg.stdout,
        stderr: msg.stderr,
      }
    case 'dev-sync-result':
      return {
        kind: 'dev-sync-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      }
    case 'tunnel-token-result':
      return {
        kind: 'tunnel-token-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      }
    case 'update-result':
      return {
        kind: 'update-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      }
    default:
      return null
  }
}

export function outboundEnvelopeToWireMessage(
  env: DaemonOutboundEnvelope,
): DaemonMessage {
  switch (env.kind) {
    case 'command':
      return { type: 'command', id: env.requestId, command: env.command, at: env.at }
    case 'addresses-request':
      return { type: 'addresses-request', id: env.requestId, at: env.at }
    case 'dev-sync':
      if (env.phase === 'begin') {
        return {
          type: 'dev-sync-begin',
          id: env.requestId,
          totalChunks: env.totalChunks,
          totalBytes: env.totalBytes,
          at: env.at,
        }
      }
      if (env.phase === 'chunk') {
        return {
          type: 'dev-sync-chunk',
          id: env.requestId,
          index: env.index,
          data: env.data,
          at: env.at,
        }
      }
      return { type: 'dev-sync-end', id: env.requestId, at: env.at }
    case 'tunnel-token':
      return {
        type: 'tunnel-token',
        id: env.requestId,
        token: env.token,
        at: env.at,
      }
    case 'update':
      return {
        type: 'update',
        id: env.requestId,
        updateUrl: env.updateUrl,
        at: env.at,
      }
    case 'ping':
      return { type: 'ping', id: env.requestId, at: env.at }
    case 'echo':
      return { type: 'echo', payload: env.payload, at: env.at }
  }
}

export function generateRequestId(): OutboundRequestId {
  return crypto.randomUUID()
}

export function generateDeliveryId(): OutboxDeliveryId {
  return crypto.randomUUID()
}
