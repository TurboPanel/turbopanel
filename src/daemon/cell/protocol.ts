import type { ServerAddresses } from "../../server-addresses.ts";
import type {
  ServerOsMetadata,
  ServerTimeSync,
} from "../../lib/db/server-metadata.ts";

export type DaemonAgentInfo = {
  commit: string;
  buildId: string;
  builtAt?: string;
  channel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseDaemonAgentInfo(
  value: unknown,
): DaemonAgentInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.commit) || value.commit.length === 0) return undefined;
  if (!isString(value.buildId) || value.buildId.length === 0) return undefined;
  const agent: DaemonAgentInfo = {
    commit: value.commit,
    buildId: value.buildId,
  };
  if (isString(value.builtAt)) agent.builtAt = value.builtAt;
  if (isString(value.channel)) agent.channel = value.channel;
  return agent;
}

/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | {
    type: "hello";
    at: string;
    agent: DaemonAgentInfo;
    hostname?: string;
    machineId?: string;
    /** Host OS from `/etc/os-release` (+ Deno build); persisted to `server.metadata.os`. */
    os?: ServerOsMetadata;
    /** Host timezone + NTP state; persisted to `server.metadata.timeSync`. */
    timeSync?: ServerTimeSync;
    /** Host interface addresses; persisted to `server.metadata.addresses`. */
    addresses?: ServerAddresses;
  }
  | {
    type: "heartbeat";
    at: string;
    agent?: DaemonAgentInfo;
    /** Change-detected time-sync facts; persisted to `server.metadata.timeSync`. */
    timeSync?: ServerTimeSync;
    /** Change-detected addresses; persisted to `server.metadata.addresses`. */
    addresses?: ServerAddresses;
  }
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    addresses: ServerAddresses;
    at: string;
  }
  | {
    type: "dev-sync-begin";
    id: string;
    totalChunks: number;
    totalBytes: number;
    at: string;
  }
  | {
    type: "dev-sync-chunk";
    id: string;
    index: number;
    data: string;
    at: string;
  }
  | { type: "dev-sync-end"; id: string; at: string }
  | {
    type: "dev-sync-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "tunnel-token"; id: string; token: string; at: string }
  | {
    type: "tunnel-token-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | { type: "public-urls-update"; id: string; urls: string[]; at: string }
  | {
    type: "public-urls-update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "update";
    id: string;
    channel?: string;
    updateUrl?: string;
    updateSha256?: string;
    at: string;
  }
  | {
    type: "update-result";
    id: string;
    ok: boolean;
    error?: string;
    at: string;
  }
  | {
    type: "command-dispatch";
    id: string;
    commandId: string;
    commandType: string;
    payload: unknown;
    at: string;
  }
  | {
    type: "command-ack";
    id: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    type: "command-outcome";
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    at: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  };

/** Read-time stale window when no inbound traffic is recorded on the cell. */
export const DAEMON_STALE_MS = 60_000;
/** Background sweep threshold for marking connected cells offline (DO alarm + Redis maintain). */
export const DAEMON_OFFLINE_SWEEP_MS = 150_000;
/** Redis cell registry maintenance interval (prune); not used for liveness. */
export const DAEMON_CELL_MAINTAIN_MS = 60_000;

/** Message types accepted from daemons after authentication succeeds. */
export const DAEMON_INBOUND_ALLOWED = new Set(
  [
    "hello",
    "heartbeat",
    "addresses-result",
    "dev-sync-result",
    "tunnel-token-result",
    "public-urls-update-result",
    "update-result",
    "command-ack",
    "command-outcome",
  ] as const,
);


/** Auto-response ping/pong pair — handled by the runtime without waking the DO. */
export const DAEMON_CELL_PING = '{"type":"ping"}';
export const DAEMON_CELL_PONG = '{"type":"pong"}';

/** Per-outbox-entry identity for queue send/ack/resend semantics. */
export type OutboxDeliveryId = string; // NOSONAR typescript:S6564 — semantic alias for delivery queue keys

/** Correlation/idempotency key shared by all frames in a multi-message request. */
export type OutboundRequestId = string; // NOSONAR typescript:S6564 — semantic alias for request correlation

type OutboundEnvelopeBase = {
  /** Unique outbox entry key; distinct for every queued delivery. */
  deliveryId: OutboxDeliveryId;
  /** Correlates multi-frame requests (e.g. dev-sync chunks) and inbound acks. */
  requestId: OutboundRequestId;
  at: string;
};

/** Cell-internal outbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonOutboundEnvelope =
  | (OutboundEnvelopeBase & { kind: "addresses-request" })
  | (OutboundEnvelopeBase & {
    kind: "dev-sync";
    phase: "begin";
    totalChunks: number;
    totalBytes: number;
  })
  | (OutboundEnvelopeBase & {
    kind: "dev-sync";
    phase: "chunk";
    index: number;
    data: string;
  })
  | (OutboundEnvelopeBase & { kind: "dev-sync"; phase: "end" })
  | (OutboundEnvelopeBase & { kind: "tunnel-token"; token: string })
  | (OutboundEnvelopeBase & { kind: "public-urls-update"; urls: string[] })
  | (OutboundEnvelopeBase & {
    kind: "update";
    channel?: string;
    updateUrl?: string;
    updateSha256?: string;
  })
  | (OutboundEnvelopeBase & { kind: "echo"; payload: unknown })
  | (OutboundEnvelopeBase & {
    kind: "command-dispatch";
    commandId: string;
    commandType: string;
    payload: unknown;
  });

/** Cell-internal inbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonInboundEnvelope =
  | {
    kind: "addresses-result";
    requestId: string;
    at: string;
    addresses: ServerAddresses;
  }
  | {
    kind: "dev-sync-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "tunnel-token-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "public-urls-update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "update-result";
    requestId: string;
    at: string;
    ok: boolean;
    error?: string;
  }
  | {
    kind: "command-ack";
    requestId: string;
    at: string;
    daemonReceivedAt: string;
  }
  | {
    kind: "command-outcome";
    requestId: string;
    at: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    daemonReceivedAt?: string;
    daemonRespondedAt?: string;
  }

export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage;
  } catch {
    return null;
  }
}

export function wireMessageToInboundEnvelope(
  msg: DaemonMessage,
): DaemonInboundEnvelope | null {
  switch (msg.type) {
    case "hello":
    case "heartbeat":
      return null;

    case "addresses-result":
      return {
        kind: "addresses-result",
        requestId: msg.id,
        at: msg.at,
        addresses: msg.addresses,
      };
    case "dev-sync-result":
      return {
        kind: "dev-sync-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "tunnel-token-result":
      return {
        kind: "tunnel-token-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "public-urls-update-result":
      return {
        kind: "public-urls-update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "update-result":
      return {
        kind: "update-result",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      };
    case "command-ack":
      return {
        kind: "command-ack",
        requestId: msg.id,
        at: msg.at,
        daemonReceivedAt: msg.daemonReceivedAt,
      };
    case "command-outcome":
      return {
        kind: "command-outcome",
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        result: msg.result,
        error: msg.error,
        daemonReceivedAt: msg.daemonReceivedAt,
        daemonRespondedAt: msg.daemonRespondedAt,
      };
    default:
      return null;
  }
}

export function outboundEnvelopeToWireMessage(
  env: DaemonOutboundEnvelope,
): DaemonMessage {
  switch (env.kind) {
    case "addresses-request":
      return { type: "addresses-request", id: env.requestId, at: env.at };
    case "dev-sync":
      if (env.phase === "begin") {
        return {
          type: "dev-sync-begin",
          id: env.requestId,
          totalChunks: env.totalChunks,
          totalBytes: env.totalBytes,
          at: env.at,
        };
      }
      if (env.phase === "chunk") {
        return {
          type: "dev-sync-chunk",
          id: env.requestId,
          index: env.index,
          data: env.data,
          at: env.at,
        };
      }
      return { type: "dev-sync-end", id: env.requestId, at: env.at };
    case "tunnel-token":
      return {
        type: "tunnel-token",
        id: env.requestId,
        token: env.token,
        at: env.at,
      };
    case "public-urls-update":
      return {
        type: "public-urls-update",
        id: env.requestId,
        urls: env.urls,
        at: env.at,
      };
    case "update":
      return {
        type: "update",
        id: env.requestId,
        at: env.at,
        ...(env.channel !== undefined ? { channel: env.channel } : {}),
        ...(env.updateUrl !== undefined ? { updateUrl: env.updateUrl } : {}),
        ...(env.updateSha256 !== undefined
          ? { updateSha256: env.updateSha256 }
          : {}),
      };
    case "echo":
      return { type: "echo", payload: env.payload, at: env.at };
    case "command-dispatch":
      return {
        type: "command-dispatch",
        id: env.requestId,
        commandId: env.commandId,
        commandType: env.commandType,
        payload: env.payload,
        at: env.at,
      };
  }
}

export function generateRequestId(): OutboundRequestId {
  return crypto.randomUUID();
}

export function generateDeliveryId(): OutboxDeliveryId {
  return crypto.randomUUID();
}
