import {
  buildHostMetricsSample,
  HOST_METRIC_KEYS,
  type HostMetricKey,
  type HostMetrics,
  type HostMetricsDimensions,
  METRICS_SCHEMA_VERSION,
} from "./contract.ts";
import { sanitizeMetricValue } from "./metric-descriptors.ts";
import type { AuthenticatedHostMetricsSample } from "./types.ts";

export const MAX_METRICS_SKEW_MS = 300_000;
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 3600;
export const MAX_DIMENSION_LEN = 256;
/** Cap on interface-list dimension arrays (`uplinkInterfaces` / `fabricInterfaces`). */
export const MAX_INTERFACE_LIST_LEN = 8;
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

function sanitizeMetricsWithDescriptors(
  metrics: HostMetrics,
): HostMetrics {
  const out = { ...metrics };
  for (const key of HOST_METRIC_KEYS) {
    out[key] = sanitizeMetricValue(key, out[key]);
  }
  return out;
}

function readBoundedStringArray(
  value: unknown,
  field: string,
): ValidateResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `metrics ${field} must be an array` };
  }
  if (value.length > MAX_INTERFACE_LIST_LEN) {
    return {
      ok: false,
      reason: `metrics ${field} exceeds max length ${MAX_INTERFACE_LIST_LEN}`,
    };
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = readBoundedString(value[i], `${field}[${i}]`);
    if (!entry.ok) return entry;
    out.push(entry.value);
  }
  return { ok: true, value: out };
}

const OPTIONAL_SENSOR_DIMENSIONS = [
  "cpuTemperatureSensor",
  "gpuTemperatureSensor",
  "cpuPowerSensor",
  "gpuPowerSensor",
] as const;

const OPTIONAL_INTERFACE_DIMENSIONS = [
  "uplinkInterfaces",
  "fabricInterfaces",
] as const;

const REQUIRED_STRING_DIMENSIONS = [
  "daemonVersion",
  "operatingSystem",
  "architecture",
  "kernelRelease",
] as const;

type RequiredStringDimension = (typeof REQUIRED_STRING_DIMENSIONS)[number];

function readRequiredDimensionStrings(
  raw: Record<string, unknown>,
): ValidateResult<Record<RequiredStringDimension, string>> {
  const out: Partial<Record<RequiredStringDimension, string>> = {};
  for (const field of REQUIRED_STRING_DIMENSIONS) {
    const parsed = readBoundedString(raw[field], `dimensions.${field}`);
    if (!parsed.ok) return parsed;
    out[field] = parsed.value;
  }
  return { ok: true, value: out as Record<RequiredStringDimension, string> };
}

/** Optional dimensions are copied only when present; a malformed one fails. */
function applyOptionalDimensions(
  raw: Record<string, unknown>,
  dimensions: HostMetricsDimensions,
): ValidateFail | null {
  if (raw.runtimeMode !== undefined) {
    const runtimeMode = readBoundedString(
      raw.runtimeMode,
      "dimensions.runtimeMode",
    );
    if (!runtimeMode.ok) return runtimeMode;
    dimensions.runtimeMode = runtimeMode.value;
  }
  for (const field of OPTIONAL_SENSOR_DIMENSIONS) {
    if (raw[field] === undefined) continue;
    const sensor = readBoundedString(raw[field], `dimensions.${field}`);
    if (!sensor.ok) return sensor;
    dimensions[field] = sensor.value;
  }
  for (const field of OPTIONAL_INTERFACE_DIMENSIONS) {
    if (raw[field] === undefined) continue;
    const interfaces = readBoundedStringArray(
      raw[field],
      `dimensions.${field}`,
    );
    if (!interfaces.ok) return interfaces;
    dimensions[field] = interfaces.value;
  }
  return null;
}

function parseDimensions(
  raw: unknown,
): ValidateResult<HostMetricsDimensions> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "metrics dimensions must be an object" };
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
  const required = readRequiredDimensionStrings(raw);
  if (!required.ok) return required;

  const dimensions: HostMetricsDimensions = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    ...required.value,
    collectionMode: raw.collectionMode,
  };
  const optionalFailure = applyOptionalDimensions(raw, dimensions);
  if (optionalFailure) return optionalFailure;
  return { ok: true, value: dimensions };
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
      reason: `metrics version must be ${METRICS_SCHEMA_VERSION}`,
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

function parseMetrics(
  raw: unknown,
): ValidateResult<Partial<Record<HostMetricKey, number | null>>> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "metrics metrics must be an object" };
  }
  // Exact v2 contract: reject out-of-allowlist keys instead of dropping them,
  // so daemon/control-plane drift surfaces immediately.
  for (const key of Object.keys(raw)) {
    if (!HOST_METRIC_KEY_SET.has(key)) {
      return {
        ok: false,
        reason: `metrics metrics.${key} is not in the v2 metric allowlist`,
      };
    }
  }
  const partialMetrics: Partial<
    Record<HostMetricKey, number | null>
  > = {};
  for (const key of HOST_METRIC_KEYS) {
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

  const metrics = parseMetrics(envelope.value.metrics);
  if (!metrics.ok) return metrics;

  let built;
  try {
    built = buildHostMetricsSample({
      at: at.value,
      intervalSeconds: intervalSeconds.value,
      sequence: sequence.value,
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
      dimensions: built.dimensions,
      metrics: sanitizeMetricsWithDescriptors(built.metrics),
    },
  };
}
