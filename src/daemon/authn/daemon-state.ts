export type ServerDaemonKey = {
  id: string;
  algorithm: "Ed25519";
  publicJwk: JsonWebKey;
  fingerprint: string;
  createdAt: string;
  revokedAt?: string | null;
  /** Updated on JWT session issuance — canonical Postgres key-use tracking. */
  lastUsedAt?: string | null;
};

export type UpdateProjection = {
  status: "idle" | "updating" | "done" | "failed" | "expired";
  channel?: string;
  requestId?: string;
  queuedAt?: string;
  finishedAt?: string;
  error?: string;
};

/** sparse Postgres projection of daemon identity (never full resource graph). */
export type ServerDaemonProjection = {
  hostname?: string;
  machineKey?: string;
  remoteAddress?: string;
  keyId?: string;
  daemonBuild?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
  update?: UpdateProjection;
};

/** Fleet liveness — stored on dedicated `server` columns, not `server.daemon`. */
export type ServerDaemonStatus = {
  connected: boolean;
  /** Derived from `connected` + `statusChangedAt` — never stored. */
  daemonStatus: "online" | "offline" | "unknown" | null;
  statusChangedAt: string | null;
};

/** Sparse jsonb blob: `{ key, projection? }` — status lives in columns. */
export type ServerDaemonState = {
  key: ServerDaemonKey;
  projection?: ServerDaemonProjection;
};

/** Column row shape used by {@link mapServerDaemonStatusFromColumns}. */
export type ServerDaemonStatusColumns = {
  connected: boolean | null | undefined;
  statusChangedAt: string | null | undefined;
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

const UPDATE_PROJECTION_STATUSES = new Set<UpdateProjection["status"]>([
  "idle",
  "updating",
  "done",
  "failed",
  "expired",
]);

function parseUpdateProjection(raw: unknown): UpdateProjection | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const update = raw as Record<string, unknown>;
  if (
    typeof update.status !== "string" ||
    !UPDATE_PROJECTION_STATUSES.has(update.status as UpdateProjection["status"])
  ) {
    return undefined;
  }
  const parsed: UpdateProjection = {
    status: update.status as UpdateProjection["status"],
  };
  if (isNonEmptyString(update.channel)) parsed.channel = update.channel;
  if (isNonEmptyString(update.requestId)) parsed.requestId = update.requestId;
  if (isNonEmptyString(update.queuedAt)) parsed.queuedAt = update.queuedAt;
  if (isNonEmptyString(update.finishedAt)) parsed.finishedAt = update.finishedAt;
  if (isNonEmptyString(update.error)) parsed.error = update.error;
  return parsed;
}

function parseProjectionDaemonBuild(
  raw: unknown,
): ServerDaemonProjection["daemonBuild"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const daemonBuild = raw as Record<string, unknown>;
  const result: NonNullable<ServerDaemonProjection["daemonBuild"]> = {};
  if (isNonEmptyString(daemonBuild.commit)) result.commit = daemonBuild.commit;
  if (isNonEmptyString(daemonBuild.buildId)) result.buildId = daemonBuild.buildId;
  if (isNonEmptyString(daemonBuild.builtAt)) result.builtAt = daemonBuild.builtAt;
  if (isNonEmptyString(daemonBuild.channel)) result.channel = daemonBuild.channel;
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
  const parsedDaemonBuild = parseProjectionDaemonBuild(projection.daemonBuild);
  const parsedUpdate = parseUpdateProjection(projection.update);

  const parsed: ServerDaemonProjection = {
    hostname: isNonEmptyString(projection.hostname)
      ? projection.hostname
      : undefined,
    machineKey: isNonEmptyString(projection.machineKey)
      ? projection.machineKey
      : undefined,
    remoteAddress: isNonEmptyString(projection.remoteAddress)
      ? projection.remoteAddress
      : undefined,
    keyId: isNonEmptyString(projection.keyId) ? projection.keyId : undefined,
    ...(parsedDaemonBuild ? { daemonBuild: parsedDaemonBuild } : {}),
    ...(parsedUpdate ? { update: parsedUpdate } : {}),
  };

  if (
    parsed.hostname === undefined &&
    parsed.machineKey === undefined &&
    parsed.remoteAddress === undefined &&
    parsed.keyId === undefined &&
    parsed.daemonBuild === undefined &&
    parsed.update === undefined
  ) {
    return null;
  }

  return parsed;
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
  const parsed: ServerDaemonKey = {
    id: key.id,
    algorithm: "Ed25519",
    publicJwk: key.publicJwk,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt ?? null,
  };
  if (isOptionalTimestamp(key.lastUsedAt)) {
    parsed.lastUsedAt = key.lastUsedAt ?? null;
  }
  return parsed;
}

export function buildDefaultDaemonStatus(): ServerDaemonStatus {
  return {
    connected: false,
    daemonStatus: "unknown",
    statusChangedAt: null,
  };
}

/** Map dedicated `server` status columns into the stable status DTO. */
export function mapServerDaemonStatusFromColumns(
  columns: ServerDaemonStatusColumns,
): ServerDaemonStatus {
  const statusChangedAt = columns.statusChangedAt ?? null;
  const connected = columns.connected === true;
  let daemonStatus: ServerDaemonStatus["daemonStatus"] = "unknown";
  if (statusChangedAt != null && String(statusChangedAt).trim() !== "") {
    daemonStatus = connected ? "online" : "offline";
  }
  return {
    connected,
    daemonStatus,
    statusChangedAt,
  };
}

/**
 * Parse the sparse `server.daemon` jsonb blob (`key` + optional `projection`).
 * Fleet status is not read from jsonb — use {@link mapServerDaemonStatusFromColumns}.
 */
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
