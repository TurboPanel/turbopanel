/** versioned monitoring wire protocol; bump when breaking monitor message shapes. */
export const MONITOR_PROTOCOL_VERSION = 1;

export const MONITOR_RESOURCE_STATUSES = [
  "unknown",
  "starting",
  "healthy",
  "degraded",
  "unhealthy",
  "stopped",
  "failed",
  "offline",
] as const;

export type MonitorResourceStatus = (typeof MONITOR_RESOURCE_STATUSES)[number];

const MONITOR_RESOURCE_STATUS_SET = new Set<string>(MONITOR_RESOURCE_STATUSES);

export function isMonitorResourceStatus(
  value: unknown,
): value is MonitorResourceStatus {
  return typeof value === "string" && MONITOR_RESOURCE_STATUS_SET.has(value);
}

export type MonitorResourceKind =
  | "instance"
  | "project"
  | "service"
  | "container";

const MONITOR_RESOURCE_KINDS = new Set<string>([
  "instance",
  "project",
  "service",
  "container",
]);

function isMonitorResourceKind(value: unknown): value is MonitorResourceKind {
  return typeof value === "string" && MONITOR_RESOURCE_KINDS.has(value);
}

/** host/system summary reported by the daemon monitor loop. */
export type MonitorInstanceSummary = {
  cpu?: { usagePercent?: number; cores?: number };
  memory?: { usedBytes?: number; totalBytes?: number; usagePercent?: number };
  disk?: { usedBytes?: number; totalBytes?: number; usagePercent?: number };
  load?: { one?: number; five?: number; fifteen?: number };
  uptimeSeconds?: number;
  bootId?: string;
};

/** normalized resource state for a monitored entity. */
export type MonitorResourceState = {
  resourceKey: string;
  kind: MonitorResourceKind;
  status: MonitorResourceStatus;
  name?: string;
  image?: string;
  healthStatus?: string;
  restartCount?: number;
  ports?: string[];
  labels?: Record<string, string>;
  projectId?: string;
  serviceId?: string;
  containerId?: string;
  updatedAt?: string;
};

/** status transition event emitted when a resource changes health. */
export type MonitorEvent = {
  resourceKey?: string;
  kind?: MonitorResourceKind;
  fromStatus?: MonitorResourceStatus;
  toStatus: MonitorResourceStatus;
  at: string;
  reason?: string;
  sequence?: number;
};

/** minute-bucket lightweight metric sample. */
export type MonitorMetricSample = {
  at: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  load?: number;
};

export type DaemonAgentInfo = {
  commit: string;
  buildId: string;
  builtAt?: string;
  channel?: string;
};

export type MonitorSyncMessage = {
  type: "monitor.sync";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  instance: MonitorInstanceSummary;
  resources: MonitorResourceState[];
  events?: MonitorEvent[];
  protocolVersion: typeof MONITOR_PROTOCOL_VERSION;
  agent?: DaemonAgentInfo;
};

export type MonitorHeartbeatMessage = {
  type: "monitor.heartbeat";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  instance: MonitorInstanceSummary;
  resources?: MonitorResourceState[];
  events?: MonitorEvent[];
  agent?: DaemonAgentInfo;
};

export type MonitorTransitionMessage = {
  type: "monitor.transition";
  from: "daemon";
  serverId: string;
  at: string;
  sequence: number;
  events: MonitorEvent[];
  resources?: MonitorResourceState[];
};

export type MonitorAckMessage = {
  type: "monitor.ack";
  from: "instance";
  serverId: string;
  at: string;
  acceptedSequence: number;
  resyncNeeded?: boolean;
};

export type MonitorMessage =
  | MonitorSyncMessage
  | MonitorHeartbeatMessage
  | MonitorTransitionMessage
  | MonitorAckMessage;

const MONITOR_MESSAGE_TYPES = new Set<string>([
  "monitor.sync",
  "monitor.heartbeat",
  "monitor.transition",
  "monitor.ack",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMonitorResourceState(value: unknown): value is MonitorResourceState {
  if (!isRecord(value)) return false;
  if (!isString(value.resourceKey)) return false;
  if (!isMonitorResourceKind(value.kind)) return false;
  if (!isMonitorResourceStatus(value.status)) return false;
  return true;
}

function isMonitorResourceStateArray(
  value: unknown,
): value is MonitorResourceState[] {
  return Array.isArray(value) && value.every(isMonitorResourceState);
}

function isMonitorEvent(value: unknown): value is MonitorEvent {
  if (!isRecord(value)) return false;
  if (!isMonitorResourceStatus(value.toStatus)) return false;
  if (!isString(value.at)) return false;
  if (value.resourceKey !== undefined && !isString(value.resourceKey)) {
    return false;
  }
  if (value.kind !== undefined && !isMonitorResourceKind(value.kind)) {
    return false;
  }
  if (
    value.fromStatus !== undefined && !isMonitorResourceStatus(value.fromStatus)
  ) return false;
  if (value.reason !== undefined && !isString(value.reason)) return false;
  if (value.sequence !== undefined && !isNumber(value.sequence)) return false;
  return true;
}

function isMonitorEventArray(value: unknown): value is MonitorEvent[] {
  return Array.isArray(value) && value.every(isMonitorEvent);
}

function isMonitorInstanceSummary(
  value: unknown,
): value is MonitorInstanceSummary {
  return isRecord(value);
}

function parseDaemonAgentInfo(value: unknown): DaemonAgentInfo | undefined {
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

function parseMonitorMessageObject(
  value: Record<string, unknown>,
): MonitorMessage | null {
  const type = value.type;
  if (!isString(type) || !MONITOR_MESSAGE_TYPES.has(type)) return null;
  if (!isString(value.serverId)) return null;
  if (!isString(value.at)) return null;

  switch (type) {
    case "monitor.sync": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorInstanceSummary(value.instance)) return null;
      if (!isMonitorResourceStateArray(value.resources)) return null;
      if (value.events !== undefined && !isMonitorEventArray(value.events)) {
        return null;
      }
      if (value.protocolVersion !== MONITOR_PROTOCOL_VERSION) return null;
      const syncAgent = parseDaemonAgentInfo(value.agent);
      return {
        type: "monitor.sync",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        instance: value.instance,
        resources: value.resources,
        events: value.events,
        protocolVersion: MONITOR_PROTOCOL_VERSION,
        ...(syncAgent ? { agent: syncAgent } : {}),
      };
    }
    case "monitor.heartbeat": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorInstanceSummary(value.instance)) return null;
      if (
        value.resources !== undefined &&
        !isMonitorResourceStateArray(value.resources)
      ) {
        return null;
      }
      if (value.events !== undefined && !isMonitorEventArray(value.events)) {
        return null;
      }
      const heartbeatAgent = parseDaemonAgentInfo(value.agent);
      return {
        type: "monitor.heartbeat",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        instance: value.instance,
        resources: value.resources,
        events: value.events,
        ...(heartbeatAgent ? { agent: heartbeatAgent } : {}),
      };
    }
    case "monitor.transition": {
      if (value.from !== "daemon") return null;
      if (!isNumber(value.sequence)) return null;
      if (!isMonitorEventArray(value.events)) return null;
      if (
        value.resources !== undefined &&
        !isMonitorResourceStateArray(value.resources)
      ) {
        return null;
      }
      return {
        type: "monitor.transition",
        from: "daemon",
        serverId: value.serverId,
        at: value.at,
        sequence: value.sequence,
        events: value.events,
        resources: value.resources,
      };
    }
    case "monitor.ack": {
      if (value.from !== "instance") return null;
      if (!isNumber(value.acceptedSequence)) return null;
      if (
        value.resyncNeeded !== undefined &&
        typeof value.resyncNeeded !== "boolean"
      ) {
        return null;
      }
      return {
        type: "monitor.ack",
        from: "instance",
        serverId: value.serverId,
        at: value.at,
        acceptedSequence: value.acceptedSequence,
        resyncNeeded: value.resyncNeeded,
      };
    }
    default:
      return null;
  }
}

/** validate and parse a monitor wire message from json or an already-parsed value. */
export function parseMonitorMessage(
  raw: string | unknown,
): MonitorMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  return parseMonitorMessageObject(value);
}

/**
 * merge incoming resource states into the current snapshot by resourceKey;
 * later entries override earlier ones for the same key.
 */
export function mergeResourceStates(
  current: MonitorResourceState[],
  incoming: MonitorResourceState[],
): MonitorResourceState[] {
  const byKey = new Map<string, MonitorResourceState>();
  for (const resource of current) byKey.set(resource.resourceKey, resource);
  for (const resource of incoming) byKey.set(resource.resourceKey, resource);
  return [...byKey.values()];
}

/**
 * apply a delta of changed resources onto the current snapshot;
 * placeholder until storage/time logic lands in a later phase.
 */
export function applyResourceDelta(
  current: MonitorResourceState[],
  delta: MonitorResourceState[],
): MonitorResourceState[] {
  return mergeResourceStates(current, delta);
}

export type MonitorSequenceDecision =
  | { action: "noop"; acceptedSequence: number; resyncNeeded: false }
  | { action: "accept"; acceptedSequence: number; resyncNeeded: false }
  | { action: "gap"; acceptedSequence: number; resyncNeeded: true };

/** idempotent apply-by-sequence: noop on duplicate/stale, accept on next, gap otherwise. */
export function evaluateMonitorSequence(
  currentSequence: number,
  incomingSequence: number,
): MonitorSequenceDecision {
  if (incomingSequence <= currentSequence) {
    return {
      action: "noop",
      acceptedSequence: currentSequence,
      resyncNeeded: false,
    };
  }
  if (incomingSequence === currentSequence + 1) {
    return {
      action: "accept",
      acceptedSequence: incomingSequence,
      resyncNeeded: false,
    };
  }
  return {
    action: "gap",
    acceptedSequence: currentSequence,
    resyncNeeded: true,
  };
}

/**
 * full-sync baseline rule: accept any newer sequence as authoritative;
 * duplicate or stale sync messages stay idempotent.
 */
export function evaluateFullSyncSequence(
  currentSequence: number,
  incomingSequence: number,
): MonitorSequenceDecision {
  if (incomingSequence <= currentSequence) {
    return {
      action: "noop",
      acceptedSequence: currentSequence,
      resyncNeeded: false,
    };
  }
  return {
    action: "accept",
    acceptedSequence: incomingSequence,
    resyncNeeded: false,
  };
}

/** grace period after last heartbeat before marking resources offline. */
export const MONITOR_OFFLINE_GRACE_MS = 150_000;

/** expected daemon monitor heartbeat cadence for deadline scheduling. */
export const MONITOR_HEARTBEAT_CADENCE_MS = 60_000;

/** alert notification cooldown between repeated notifies for the same resource. */
export const MONITOR_ALERT_COOLDOWN_MS = 300_000;

/**
 * derive effective resource status from stored status and last heartbeat age;
 * returns offline when heartbeat is stale unless already stopped/failed.
 */
export function computeEffectiveStatus(
  currentStatus: MonitorResourceStatus,
  lastHeartbeatAt: string,
  now = Date.now(),
): MonitorResourceStatus {
  if (currentStatus === "stopped" || currentStatus === "failed") {
    return currentStatus;
  }
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (
    !Number.isNaN(heartbeatMs) &&
    now - heartbeatMs > MONITOR_OFFLINE_GRACE_MS
  ) {
    return "offline";
  }
  return currentStatus;
}

/** truncate an ISO timestamp to a canonical UTC minute bucket. */
export function normalizeMonitorMetricBucket(at: string): string {
  const ms = Date.parse(at);
  const bucketMs = Number.isNaN(ms)
    ? Math.floor(Date.now() / 60_000) * 60_000
    : Math.floor(ms / 60_000) * 60_000;
  return new Date(bucketMs).toISOString();
}
