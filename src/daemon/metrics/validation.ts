import {
  buildHostMetricsSample,
  HOST_METRIC_KEYS,
  type HostMetricKey,
  type HostMetricsDimensions,
  METRIC_PARTS,
  METRICS_SCHEMA_VERSION,
  type MetricPart,
  type PartialHostMetrics,
  type TrafficSourceContribution,
} from "./contract.ts";
import {
  HOST_METRICS_METRIC_DESCRIPTORS,
  sanitizeMetricValue,
} from "./metric-descriptors.ts";
import type { AuthenticatedHostMetricsSample } from "./types.ts";

export const MAX_METRICS_SKEW_MS = 300_000;
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 3600;
export const MAX_DIMENSION_LEN = 256;
/** Hard cap on raw metrics frame size (UTF-8 bytes). */
export const MAX_METRICS_PAYLOAD_BYTES = 16_384;
export const METRICS_LOG_COOLDOWN_MS = 5 * 60_000;

const rateLimitedLogAt = new Map<string, number>();

/** Rate-limited diagnostic log — at most once per cooldown per serverId+reason. */
export function rateLimitedMetricsLog(
  serverId: string,
  reason: string,
  log: (message: string) => void,
  nowMs = Date.now(),
): void {
  const key = `${serverId}\0${reason}`;
  const last = rateLimitedLogAt.get(key);
  if (last !== undefined && nowMs - last < METRICS_LOG_COOLDOWN_MS) {
    return;
  }
  rateLimitedLogAt.set(key, nowMs);
  log(reason);
}

/** Test seam: clear rate-limit cooldown map. */
export function resetMetricsRateLimitForTests(): void {
  rateLimitedLogAt.clear();
}

/** UTF-8 byte length of a WebSocket text frame (or ArrayBuffer frame). */
export function metricsPayloadByteLength(
  raw: string | ArrayBuffer,
): number {
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw).byteLength;
  }
  return raw.byteLength;
}

type ValidateFail = { ok: false; reason: string };
type ValidateOk<T> = { ok: true; value: T };
type ValidateResult<T> = ValidateOk<T> | ValidateFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedString(
  value: unknown,
  field: string,
): ValidateResult<string> {
  if (typeof value !== "string") {
    return { ok: false, reason: `metrics ${field} must be a string` };
  }
  if (value.length > MAX_DIMENSION_LEN) {
    return {
      ok: false,
      reason: `metrics ${field} exceeds max length ${MAX_DIMENSION_LEN}`,
    };
  }
  return { ok: true, value };
}

function readRequiredNonNegativeInteger(
  raw: Record<string, unknown>,
  field: string,
): ValidateResult<number> {
  const value = raw[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return {
      ok: false,
      reason: `metrics dimensions.${field} must be a safe non-negative integer`,
    };
  }
  return { ok: true, value };
}

/**
 * Sanitize only the keys actually present on the sample — an absent key
 * means "not collected this tick" and must stay absent, never backfilled to
 * `null` (that would erase the part-scoping this validator enforces).
 */
function sanitizeMetricsWithDescriptors(
  metrics: PartialHostMetrics,
): PartialHostMetrics {
  const out: PartialHostMetrics = {};
  for (const key of Object.keys(metrics) as HostMetricKey[]) {
    out[key] = sanitizeMetricValue(key, metrics[key] ?? null);
  }
  return out;
}

/**
 * The only dimension fields the v3 wire contract recognizes. Any other field
 * — including every retired v2 field (`daemonVersion`, `operatingSystem`,
 * `architecture`, `kernelRelease`, sensor identity fields, interface list
 * fields) — is rejected outright so a stale v2 sender surfaces as a
 * validation failure instead of silently passing with its dropped fields.
 */
const ALLOWED_DIMENSION_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "collectionMode",
  "runtimeMode",
  "hardwareProfileGeneration",
  "trafficSources",
]);

function parseTrafficSources(
  raw: Record<string, unknown>,
): ValidateResult<TrafficSourceContribution> {
  const value = raw.trafficSources;
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "metrics dimensions.trafficSources must be an object",
    };
  }
  if (
    typeof value.caddy !== "boolean" || typeof value.proxysql !== "boolean"
  ) {
    return {
      ok: false,
      reason:
        "metrics dimensions.trafficSources.caddy and .proxysql must be boolean",
    };
  }
  return {
    ok: true,
    value: { caddy: value.caddy, proxysql: value.proxysql },
  };
}

function parseDimensions(
  raw: unknown,
): ValidateResult<HostMetricsDimensions> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "metrics dimensions must be an object" };
  }
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_DIMENSION_FIELDS.has(field)) {
      return {
        ok: false,
        reason:
          `metrics dimensions.${field} is not a recognized v${METRICS_SCHEMA_VERSION} dimension field`,
      };
    }
  }
  if (raw.schemaVersion !== METRICS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `metrics dimensions.schemaVersion must be ${METRICS_SCHEMA_VERSION}`,
    };
  }
  if (raw.collectionMode !== "baseline" && raw.collectionMode !== "live") {
    return {
      ok: false,
      reason: 'metrics dimensions.collectionMode must be "baseline" or "live"',
    };
  }
  const hardwareProfileGeneration = readRequiredNonNegativeInteger(
    raw,
    "hardwareProfileGeneration",
  );
  if (!hardwareProfileGeneration.ok) return hardwareProfileGeneration;

  const trafficSources = parseTrafficSources(raw);
  if (!trafficSources.ok) return trafficSources;

  const dimensions: HostMetricsDimensions = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    collectionMode: raw.collectionMode,
    hardwareProfileGeneration: hardwareProfileGeneration.value,
    trafficSources: trafficSources.value,
  };
  if (raw.runtimeMode !== undefined) {
    const runtimeMode = readBoundedString(
      raw.runtimeMode,
      "dimensions.runtimeMode",
    );
    if (!runtimeMode.ok) return runtimeMode;
    dimensions.runtimeMode = runtimeMode.value;
  }
  return { ok: true, value: dimensions };
}

/** Derive the Cloudflare-facing `blob8` marker: contributing source names, in fixed order. */
function trafficSourceNames(
  trafficSources: TrafficSourceContribution,
): string[] {
  const names: string[] = [];
  if (trafficSources.caddy) names.push("caddy");
  if (trafficSources.proxysql) names.push("proxysql");
  return names;
}

function rejectOversizedPayload(
  payloadBytes: number | undefined,
): ValidateFail | null {
  if (payloadBytes === undefined || payloadBytes <= MAX_METRICS_PAYLOAD_BYTES) {
    return null;
  }
  return {
    ok: false,
    reason: `metrics payload exceeds max size ${MAX_METRICS_PAYLOAD_BYTES}`,
  };
}

function parseEnvelope(
  raw: unknown,
): ValidateResult<Record<string, unknown>> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "metrics payload must be an object" };
  }
  if (raw.type !== "metrics") {
    return { ok: false, reason: 'metrics type must be "metrics"' };
  }
  if (raw.version !== METRICS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `metrics version must be ${METRICS_SCHEMA_VERSION} (got ${String(raw.version)})`,
    };
  }
  return { ok: true, value: raw };
}

function parseTimestampAt(
  at: unknown,
  nowMs: number,
): ValidateResult<string> {
  if (typeof at !== "string" || at.length === 0) {
    return { ok: false, reason: "metrics at must be a non-empty string" };
  }
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) {
    return { ok: false, reason: "metrics at must be a valid ISO timestamp" };
  }
  if (Math.abs(nowMs - atMs) > MAX_METRICS_SKEW_MS) {
    return { ok: false, reason: "metrics at outside allowed skew window" };
  }
  return { ok: true, value: at };
}

function parseIntervalSeconds(value: unknown): ValidateResult<number> {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_INTERVAL_SECONDS ||
    value > MAX_INTERVAL_SECONDS
  ) {
    return {
      ok: false,
      reason:
        `metrics intervalSeconds must be in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}]`,
    };
  }
  return { ok: true, value };
}

function parseSequence(value: unknown): ValidateResult<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return {
      ok: false,
      reason: "metrics sequence must be a safe non-negative integer",
    };
  }
  return { ok: true, value };
}

const HOST_METRIC_KEY_SET: ReadonlySet<string> = new Set(HOST_METRIC_KEYS);
const METRIC_PART_SET: ReadonlySet<string> = new Set(METRIC_PARTS);

function parseParts(raw: unknown): ValidateResult<MetricPart[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "metrics parts must be a non-empty array" };
  }
  const parts: MetricPart[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !METRIC_PART_SET.has(entry)) {
      return {
        ok: false,
        reason: `metrics parts contains an invalid part: ${String(entry)}`,
      };
    }
    if (seen.has(entry)) {
      return {
        ok: false,
        reason: `metrics parts contains a duplicate part: ${entry}`,
      };
    }
    seen.add(entry);
    parts.push(entry as MetricPart);
  }
  if (!seen.has("core")) {
    return { ok: false, reason: 'metrics parts must include "core"' };
  }
  if (!seen.has("extended")) {
    return { ok: false, reason: 'metrics parts must include "extended"' };
  }
  return { ok: true, value: parts };
}

function parseMetrics(
  raw: unknown,
  parts: readonly MetricPart[],
): ValidateResult<Partial<Record<HostMetricKey, number | null>>> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "metrics metrics must be an object" };
  }
  const declaredParts = new Set<MetricPart>(parts);

  for (const key of Object.keys(raw)) {
    if (!HOST_METRIC_KEY_SET.has(key)) {
      return {
        ok: false,
        reason:
          `metrics metrics.${key} is not in the v${METRICS_SCHEMA_VERSION} metric allowlist`,
      };
    }
    const descriptorPart = HOST_METRICS_METRIC_DESCRIPTORS[key as HostMetricKey].part;
    if (!declaredParts.has(descriptorPart)) {
      return {
        ok: false,
        reason:
          `metrics metrics.${key} belongs to part "${descriptorPart}" which is not declared in parts`,
      };
    }
  }

  const partialMetrics: Partial<
    Record<HostMetricKey, number | null>
  > = {};
  for (const key of HOST_METRIC_KEYS) {
    const descriptorPart = HOST_METRICS_METRIC_DESCRIPTORS[key].part;
    if (!declaredParts.has(descriptorPart)) continue;
    if (!Object.hasOwn(raw, key)) {
      return {
        ok: false,
        reason: `metrics metrics.${key} is required`,
      };
    }
    const value = raw[key];
    if (value !== null && typeof value !== "number") {
      return {
        ok: false,
        reason: `metrics metrics.${key} must be a number or null`,
      };
    }
    partialMetrics[key] = value;
  }
  return { ok: true, value: partialMetrics };
}

/**
 * Validate a raw daemon metrics frame against the wire contract.
 * `serverId` always comes from `ctx` — never from the client payload.
 */
export function validateHostMetricsSample(
  raw: unknown,
  ctx: {
    serverId: string;
    receivedAt: string;
    nowMs?: number;
    /** Raw frame UTF-8 byte length; rejects when over `MAX_METRICS_PAYLOAD_BYTES`. */
    payloadBytes?: number;
  },
):
  | { ok: true; sample: AuthenticatedHostMetricsSample }
  | { ok: false; reason: string } {
  const oversized = rejectOversizedPayload(ctx.payloadBytes);
  if (oversized) return oversized;

  const envelope = parseEnvelope(raw);
  if (!envelope.ok) return envelope;

  const at = parseTimestampAt(envelope.value.at, ctx.nowMs ?? Date.now());
  if (!at.ok) return at;

  const intervalSeconds = parseIntervalSeconds(envelope.value.intervalSeconds);
  if (!intervalSeconds.ok) return intervalSeconds;

  const sequence = parseSequence(envelope.value.sequence);
  if (!sequence.ok) return sequence;

  const dimensions = parseDimensions(envelope.value.dimensions);
  if (!dimensions.ok) return dimensions;

  const parts = parseParts(envelope.value.parts);
  if (!parts.ok) return parts;

  const metrics = parseMetrics(envelope.value.metrics, parts.value);
  if (!metrics.ok) return metrics;

  let built;
  try {
    built = buildHostMetricsSample({
      at: at.value,
      intervalSeconds: intervalSeconds.value,
      sequence: sequence.value,
      parts: parts.value,
      metrics: metrics.value,
      dimensions: dimensions.value,
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "metrics sample invalid",
    };
  }

  return {
    ok: true,
    sample: {
      serverId: ctx.serverId,
      at: built.at,
      sampledAt: built.at,
      receivedAt: ctx.receivedAt,
      intervalSeconds: built.intervalSeconds,
      sequence: built.sequence,
      schemaVersion: METRICS_SCHEMA_VERSION,
      collectionMode: built.dimensions.collectionMode,
      parts: built.parts,
      dimensions: built.dimensions,
      metrics: sanitizeMetricsWithDescriptors(built.metrics),
      trafficSources: trafficSourceNames(built.dimensions.trafficSources),
    },
  };
}
