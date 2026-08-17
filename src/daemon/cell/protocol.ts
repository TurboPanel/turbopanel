import type { ServerReportedIp } from "../../server-addresses.ts";
import type {
  ServerDockerMetadata,
  ServerHostResources,
  ServerOsMetadata,
  ServerTimeSync,
} from "../../lib/db/server-metadata.ts";

export type DaemonBuildInfo = {
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

export function parseDaemonBuildInfo(
  value: unknown,
): DaemonBuildInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.commit) || value.commit.length === 0) return undefined;
  if (!isString(value.buildId) || value.buildId.length === 0) return undefined;
  const daemonBuild: DaemonBuildInfo = {
    commit: value.commit,
    buildId: value.buildId,
  };
  if (isString(value.builtAt)) daemonBuild.builtAt = value.builtAt;
  if (isString(value.channel)) daemonBuild.channel = value.channel;
  return daemonBuild;
}

/** JSON messages exchanged between the instance and daemon over /ws. */
export type DaemonMessage =
  | {
    type: "hello";
    at: string;
    daemonBuild: DaemonBuildInfo;
    hostname?: string;
    machineKey?: string;
    /** Host OS from `/etc/os-release` (+ Deno build); persisted to `server.metadata.os`. */
    os?: ServerOsMetadata;
    /**
     * Host capacity (cpu / RAM / swap totals) from `/proc`;
     * persisted to `server.metadata.resources`.
     */
    resources?: ServerHostResources;
    /** Host timezone + NTP state; persisted to `server.metadata.timeSync`. */
    timeSync?: ServerTimeSync;
    /** Host interface addresses; persisted to `server.metadata.ips`. */
    ips?: ServerReportedIp[];
    /**
     * Docker CLI / Compose plugin versions; persisted to `server.metadata.docker`.
     * Omit when Docker is not installed.
     */
    docker?: ServerDockerMetadata;
  }
  | {
    type: "heartbeat";
    at: string;
    daemonBuild?: DaemonBuildInfo;
    /** Change-detected time-sync facts; persisted to `server.metadata.timeSync`. */
    timeSync?: ServerTimeSync;
    /** Change-detected addresses; persisted to `server.metadata.ips`. */
    ips?: ServerReportedIp[];
    /**
     * Change-detected Docker facts; persisted to `server.metadata.docker`.
     * Omit when Docker is not installed.
     */
    docker?: ServerDockerMetadata;
  }
  | { type: "echo"; payload: unknown; at: string }
  | { type: "version"; commit: string; branch: string; at: string }
  | { type: "addresses-request"; id: string; at: string }
  | {
    type: "addresses-result";
    id: string;
    ips: ServerReportedIp[];
    at: string;
  }
  | {
    type: "managed-logs-request";
    id: string;
    managedId: string;
    tail: number;
    at: string;
  }
  | {
    type: "managed-logs-result";
    id: string;
    logs: string;
    error?: string;
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
    "managed-logs-result",
    "dev-sync-result",
    "tunnel-token-result",
    "public-urls-update-result",
    "update-result",
    "command-ack",
    "command-outcome",
  ] as const,
);

/** Hard cap on a single inbound WebSocket text/binary frame (UTF-8 bytes). */
export const MAX_DAEMON_WS_FRAME_BYTES = 256 * 1024;

/** Max characters for correlation / delivery identifiers (`id`, `requestId`). */
export const MAX_DAEMON_WS_ID_CHARS = 128;

/** Max characters for daemon-reported error strings. */
export const MAX_DAEMON_WS_ERROR_CHARS = 4 * 1024;

/** Max characters for `managed-logs-result.logs`. */
export const MAX_DAEMON_WS_LOGS_CHARS = 200 * 1024;

/** Max UTF-8 bytes for JSON-serialized `command-outcome.result`. */
export const MAX_DAEMON_WS_RESULT_JSON_BYTES = 64 * 1024;

/** Max characters for optional hostname / machineKey fields on hello. */
export const MAX_DAEMON_WS_HOST_FIELD_CHARS = 255;

/** WebSocket close code for policy / size violations (RFC 6455). */
export const DAEMON_WS_POLICY_VIOLATION_CLOSE = 1008;

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 40 &&
    ISO_TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DAEMON_WS_ID_CHARS;
}

function validateOptionalError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return "error must be a string";
  if (value.length > MAX_DAEMON_WS_ERROR_CHARS) {
    return "error exceeds max length";
  }
  return null;
}

function validateCommandResult(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return "result is not JSON-serializable";
    if (utf8ByteLength(encoded) > MAX_DAEMON_WS_RESULT_JSON_BYTES) {
      return "result exceeds max size";
    }
  } catch {
    return "result is not JSON-serializable";
  }
  return null;
}

function validatePresenceFields(
  record: Record<string, unknown>,
): string | null {
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (
    record.hostname !== undefined &&
    (typeof record.hostname !== "string" ||
      record.hostname.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return "invalid hostname";
  }
  if (
    record.machineKey !== undefined &&
    (typeof record.machineKey !== "string" ||
      record.machineKey.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return "invalid machineKey";
  }
  if (
    record.daemonBuild !== undefined &&
    !parseDaemonBuildInfo(record.daemonBuild)
  ) {
    return "invalid daemonBuild";
  }
  return null;
}

function validateResultEnvelopeFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  const errorIssue = validateOptionalError(record.error);
  if (errorIssue) return errorIssue;
  return null;
}

function validateOptionalIsoTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined) return null;
  if (!isIsoTimestamp(value)) return `invalid ${field}`;
  return null;
}

function validateHelloFields(record: Record<string, unknown>): string | null {
  if (!parseDaemonBuildInfo(record.daemonBuild)) return "invalid daemonBuild";
  return validatePresenceFields(record);
}

function validateAddressesResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (!Array.isArray(record.ips)) return "invalid ips";
  return null;
}

function validateManagedLogsResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.logs !== "string") return "invalid logs";
  if (record.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
    return "logs exceed max length";
  }
  return null;
}

function validateOkResultFields(
  record: Record<string, unknown>,
): string | null {
  const base = validateResultEnvelopeFields(record);
  if (base) return base;
  if (typeof record.ok !== "boolean") return "invalid ok";
  return null;
}

function validateCommandAckFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (!isIsoTimestamp(record.daemonReceivedAt)) {
    return "invalid daemonReceivedAt";
  }
  return null;
}

function validateCommandOutcomeFields(
  record: Record<string, unknown>,
): string | null {
  if (!isBoundedId(record.id)) return "invalid id";
  if (!isIsoTimestamp(record.at)) return "invalid at timestamp";
  if (typeof record.ok !== "boolean") return "invalid ok";
  const errorIssue = validateOptionalError(record.error);
  if (errorIssue) return errorIssue;
  const resultIssue = validateCommandResult(record.result);
  if (resultIssue) return resultIssue;
  return validateOptionalIsoTimestamp(
    record.daemonReceivedAt,
    "daemonReceivedAt",
  ) ??
    validateOptionalIsoTimestamp(
      record.daemonRespondedAt,
      "daemonRespondedAt",
    );
}

/**
 * Strict inbound WebSocket frame validator. Checks frame size, message type,
 * required fields, timestamp format, identifier lengths, and per-field caps
 * before any cell storage / rate-limit bookkeeping runs.
 */
export function validateDaemonInboundFrame(
  raw: string,
): { ok: true; message: DaemonMessage } | { ok: false; reason: string } {
  if (utf8ByteLength(raw) > MAX_DAEMON_WS_FRAME_BYTES) {
    return { ok: false, reason: "frame exceeds max size" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { ok: false, reason: "invalid message shape" };
  }

  if (!(DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has(parsed.type)) {
    return { ok: false, reason: `disallowed type ${parsed.type}` };
  }

  const typeIssue = validateInboundMessageFields(parsed);
  if (typeIssue) return { ok: false, reason: typeIssue };

  return { ok: true, message: parsed as DaemonMessage };
}

function validateInboundMessageFields(
  record: Record<string, unknown>,
): string | null {
  switch (record.type) {
    case "hello":
      return validateHelloFields(record);
    case "heartbeat":
      return validatePresenceFields(record);
    case "addresses-result":
      return validateAddressesResultFields(record);
    case "managed-logs-result":
      return validateManagedLogsResultFields(record);
    case "dev-sync-result":
    case "tunnel-token-result":
    case "public-urls-update-result":
    case "update-result":
      return validateOkResultFields(record);
    case "command-ack":
      return validateCommandAckFields(record);
    case "command-outcome":
      return validateCommandOutcomeFields(record);
    default:
      return `disallowed type ${String(record.type)}`;
  }
}

/**
 * Re-check normalized inbound envelope field sizes before Redis/DO persistence.
 * Callers that already ran {@link validateDaemonInboundFrame} still pass this
 * cheap guard so a forged envelope cannot bypass wire validation.
 */
export function validateDaemonInboundEnvelope(
  inbound: DaemonInboundEnvelope,
): { ok: true } | { ok: false; reason: string } {
  if (!isBoundedId(inbound.requestId)) {
    return { ok: false, reason: "invalid requestId" };
  }
  if (!isIsoTimestamp(inbound.at)) {
    return { ok: false, reason: "invalid at timestamp" };
  }

  switch (inbound.kind) {
    case "managed-logs-result": {
      if (inbound.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
        return { ok: false, reason: "logs exceed max length" };
      }
      const errorIssue = validateOptionalError(inbound.error);
      if (errorIssue) return { ok: false, reason: errorIssue };
      return { ok: true };
    }
    case "command-outcome": {
      const errorIssue = validateOptionalError(inbound.error);
      if (errorIssue) return { ok: false, reason: errorIssue };
      const resultIssue = validateCommandResult(inbound.result);
      if (resultIssue) return { ok: false, reason: resultIssue };
      return { ok: true };
    }
    case "dev-sync-result":
    case "tunnel-token-result":
    case "public-urls-update-result":
    case "update-result": {
      const errorIssue = validateOptionalError(inbound.error);
      if (errorIssue) return { ok: false, reason: errorIssue };
      return { ok: true };
    }
    case "command-ack": {
      if (!isIsoTimestamp(inbound.daemonReceivedAt)) {
        return { ok: false, reason: "invalid daemonReceivedAt" };
      }
      return { ok: true };
    }
    case "addresses-result":
      return { ok: true };
    default:
      return { ok: false, reason: "unknown envelope kind" };
  }
}

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
    kind: "managed-logs-request";
    managedId: string;
    tail: number;
  })
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
    ips: ServerReportedIp[];
  }
  | {
    kind: "managed-logs-result";
    requestId: string;
    at: string;
    logs: string;
    error?: string;
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
        ips: msg.ips,
      };
    case "managed-logs-result":
      return {
        kind: "managed-logs-result",
        requestId: msg.id,
        at: msg.at,
        logs: msg.logs,
        error: msg.error,
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
    case "managed-logs-request":
      return {
        type: "managed-logs-request",
        id: env.requestId,
        managedId: env.managedId,
        tail: env.tail,
        at: env.at,
      };
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
