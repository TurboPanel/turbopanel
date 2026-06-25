import type { MonitorResourceStatus } from "../cell/monitor-contracts.ts";

export type ServerDaemonKey = {
  id: string;
  algorithm: "Ed25519";
  publicJwk: JsonWebKey;
  fingerprint: string;
  createdAt: string;
  revokedAt?: string | null;
};

/** sparse Postgres projection of daemon presence + monitor summary (never full resource graph). */
export type ServerDaemonProjection = {
  hostname?: string;
  machineId?: string;
  remoteAddress?: string;
  keyId?: string;
  connected: boolean;
  status: MonitorResourceStatus;
  healthyCount: number;
  degradedCount: number;
  unhealthyCount: number;
  lastProjectedAt: string;
  connectedAt?: string;
  agent?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
};

export type ServerDaemonState = {
  key: ServerDaemonKey;
  projection?: ServerDaemonProjection;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalTimestamp(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || isNonEmptyString(value);
}

function isPublicJwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const jwk = value as JsonWebKey;
  return isNonEmptyString(jwk.kty) && isNonEmptyString(jwk.crv) &&
    isNonEmptyString(jwk.x);
}

function parseProjectionStatus(value: unknown): MonitorResourceStatus | null {
  if (typeof value !== "string") return null;
  const allowed = new Set([
    "unknown",
    "starting",
    "healthy",
    "degraded",
    "unhealthy",
    "stopped",
    "failed",
    "offline",
  ]);
  return allowed.has(value) ? value as MonitorResourceStatus : null;
}

function parseProjectionAgent(
  raw: unknown,
): ServerDaemonProjection["agent"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const agent = raw as Record<string, unknown>;
  const result: NonNullable<ServerDaemonProjection["agent"]> = {};
  if (isNonEmptyString(agent.commit)) result.commit = agent.commit;
  if (isNonEmptyString(agent.buildId)) result.buildId = agent.buildId;
  if (isNonEmptyString(agent.builtAt)) result.builtAt = agent.builtAt;
  if (isNonEmptyString(agent.channel)) result.channel = agent.channel;
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

function parseServerDaemonProjection(
  raw: unknown,
): ServerDaemonProjection | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const projection = raw as Record<string, unknown>;
  const status = parseProjectionStatus(projection.status);
  if (
    typeof projection.connected !== "boolean" ||
    !status ||
    typeof projection.healthyCount !== "number" ||
    typeof projection.degradedCount !== "number" ||
    typeof projection.unhealthyCount !== "number" ||
    !isNonEmptyString(projection.lastProjectedAt)
  ) {
    return null;
  }

  const parsedAgent = parseProjectionAgent(projection.agent);

  return {
    hostname: isNonEmptyString(projection.hostname)
      ? projection.hostname
      : undefined,
    machineId: isNonEmptyString(projection.machineId)
      ? projection.machineId
      : undefined,
    remoteAddress: isNonEmptyString(projection.remoteAddress)
      ? projection.remoteAddress
      : undefined,
    keyId: isNonEmptyString(projection.keyId) ? projection.keyId : undefined,
    connected: projection.connected,
    status,
    healthyCount: projection.healthyCount,
    degradedCount: projection.degradedCount,
    unhealthyCount: projection.unhealthyCount,
    lastProjectedAt: projection.lastProjectedAt,
    connectedAt: isNonEmptyString(projection.connectedAt)
      ? projection.connectedAt
      : undefined,
    ...(parsedAgent ? { agent: parsedAgent } : {}),
  };
}

function parseServerDaemonKey(raw: unknown): ServerDaemonKey | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const key = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(key.id) ||
    key.algorithm !== "Ed25519" ||
    !isPublicJwk(key.publicJwk) ||
    !isNonEmptyString(key.fingerprint) ||
    !isNonEmptyString(key.createdAt) ||
    !isOptionalTimestamp(key.revokedAt)
  ) {
    return null;
  }
  return {
    id: key.id,
    algorithm: "Ed25519",
    publicJwk: key.publicJwk,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt ?? null,
  };
}

export function parseServerDaemonState(raw: unknown): ServerDaemonState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const state = raw as Record<string, unknown>;
  const parsedKey = parseServerDaemonKey(state.key);
  if (!parsedKey) {
    return null;
  }
  const parsedProjection = state.projection != null
    ? parseServerDaemonProjection(state.projection)
    : undefined;

  return {
    key: parsedKey,
    ...(parsedProjection ? { projection: parsedProjection } : {}),
  };
}

export function isDaemonKeyActive(key: ServerDaemonKey): boolean {
  return key.revokedAt === null || key.revokedAt === undefined;
}

export function buildServerDaemonState(params: {
  publicJwk: JsonWebKey;
  fingerprint: string;
  algorithm?: "Ed25519";
}): ServerDaemonState {
  const now = new Date().toISOString();
  return {
    key: {
      id: crypto.randomUUID(),
      algorithm: params.algorithm ?? "Ed25519",
      publicJwk: params.publicJwk,
      fingerprint: params.fingerprint,
      createdAt: now,
      revokedAt: null,
    },
  };
}
