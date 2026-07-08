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
  machineId?: string;
  remoteAddress?: string;
  keyId?: string;
  agent?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
  update?: UpdateProjection;
};

export type ServerDaemonStatus = {
  connected: boolean;
  daemonStatus: "online" | "offline" | "unknown" | null;
  lastSeenAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  statusChangedAt: string | null;
};

export type ServerDaemonState = {
  key: ServerDaemonKey;
  projection?: ServerDaemonProjection;
  status?: ServerDaemonStatus;
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

function isDaemonStatusValue(
  value: unknown,
): value is ServerDaemonStatus["daemonStatus"] {
  return value === "online" || value === "offline" || value === "unknown" ||
    value === null;
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
  const parsedAgent = parseProjectionAgent(projection.agent);
  const parsedUpdate = parseUpdateProjection(projection.update);

  const parsed: ServerDaemonProjection = {
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
    ...(parsedAgent ? { agent: parsedAgent } : {}),
    ...(parsedUpdate ? { update: parsedUpdate } : {}),
  };

  if (
    parsed.hostname === undefined &&
    parsed.machineId === undefined &&
    parsed.remoteAddress === undefined &&
    parsed.keyId === undefined &&
    parsed.agent === undefined &&
    parsed.update === undefined
  ) {
    return null;
  }

  return parsed;
}

function parseServerDaemonStatus(raw: unknown): ServerDaemonStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const status = raw as Record<string, unknown>;
  if (typeof status.connected !== "boolean") {
    return null;
  }
  if (!isDaemonStatusValue(status.daemonStatus)) {
    return null;
  }
  if (
    !isOptionalTimestamp(status.lastSeenAt) ||
    !isOptionalTimestamp(status.connectedAt) ||
    !isOptionalTimestamp(status.disconnectedAt) ||
    !isOptionalTimestamp(status.statusChangedAt)
  ) {
    return null;
  }
  return {
    connected: status.connected,
    daemonStatus: status.daemonStatus,
    lastSeenAt: status.lastSeenAt ?? null,
    connectedAt: status.connectedAt ?? null,
    disconnectedAt: status.disconnectedAt ?? null,
    statusChangedAt: status.statusChangedAt ?? null,
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
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
    statusChangedAt: null,
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
  const parsedStatus = state.status != null
    ? parseServerDaemonStatus(state.status)
    : undefined;

  return {
    key: parsedKey,
    ...(parsedProjection ? { projection: parsedProjection } : {}),
    ...(parsedStatus ? { status: parsedStatus } : {}),
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
