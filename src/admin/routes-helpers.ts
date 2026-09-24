import type { Context } from "hono";
import type { Db } from "../db/connection.ts";
import type { DaemonCellRegistry } from "../contracts/cell.ts";
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
  type InstanceAcmeWireSettings,
  type InstanceHostnameWireEntry,
} from "../contracts/cell-protocol.ts";
import { cellTrace } from "../lib/logger.ts";
import type { ServerReportedIp } from "../contracts/server-addresses.ts";
import {
  INSTANCE_HOSTNAME_SOURCES,
  type InstanceHostnameSource,
} from "../features/install/instance-hostnames.ts";
import {
  getPublicUrls,
  parsePublicUrlEntries,
  setPublicUrls,
} from "../features/install/public-urls.ts";
import {
  REENCRYPT_BATCH_SIZE,
  REENCRYPT_STAGES,
  type ReencryptCursor,
  type ReencryptStage,
} from "./reencrypt-secrets.ts";

// Cert apply runs ansible, then validates and reloads Caddy through its
// admin listener so :8443 stays up. Observed ~60s wall time; keep headroom.
const PUBLIC_URLS_APPLY_TIMEOUT_MS = 180_000;

export type PublicUrlsApplyPayload = {
  urls: string[];
  hostnames?: InstanceHostnameWireEntry[];
  instanceAcme?: InstanceAcmeWireSettings;
};

function normalizePublicUrlsApply(
  urlsOrPayload: string[] | PublicUrlsApplyPayload,
): PublicUrlsApplyPayload {
  if (Array.isArray(urlsOrPayload)) return { urls: urlsOrPayload };
  return urlsOrPayload;
}

/** Trace fields for a public-urls apply. Certificate PEMs stay off the trace. */
function tracePublicUrlsPayload(
  payload: PublicUrlsApplyPayload,
): Record<string, unknown> {
  return {
    urls: payload.urls,
    ...(payload.hostnames
      ? {
        hostnames: payload.hostnames.map((entry) => ({
          host: entry.host,
          source: entry.source,
          ...(entry.uploadedCertId
            ? { uploadedCertId: entry.uploadedCertId }
            : {}),
        })),
      }
      : {}),
    ...(payload.instanceAcme ? { instanceAcme: payload.instanceAcme } : {}),
  };
}

function nowTs(): string {
  return new Date().toISOString();
}

export const MAX_CELL_PURGE_BATCH_SIZE = 200;

export function resolvePlatformEnv(
  c: Context,
  opts: { getEnv?: () => Record<string, string | undefined> },
): Record<string, string | undefined> {
  const fromContext = c.get("platformEnv");
  if (fromContext) return fromContext;
  if (opts.getEnv) return opts.getEnv();
  return {};
}

export function extractAddresses(
  record: { status: string; result?: unknown },
): ServerReportedIp[] {
  if (record.status !== "done") {
    throw new Error(
      record.status === "expired"
        ? "timeout waiting for addresses"
        : "failed to fetch addresses",
    );
  }
  const result = record.result as { ips?: ServerReportedIp[] } | undefined;
  if (!result?.ips) throw new Error("missing ips in daemon response");
  return result.ips;
}

export type PublicUrlsApplyUrlsResult =
  | { ok: true; urls: string[] }
  | { ok: false; status: 400 | 422; body: unknown };

export async function resolvePublicUrlsForApply(
  db: Db,
  body: unknown,
): Promise<PublicUrlsApplyUrlsResult> {
  if (body && typeof body === "object" && "urls" in body) {
    const urlsBody = body as { urls: unknown };
    if (
      !Array.isArray(urlsBody.urls) ||
      !urlsBody.urls.every((u: unknown) => typeof u === "string")
    ) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: "expected { urls?: string[] }" },
      };
    }
    const parsed = parsePublicUrlEntries(urlsBody.urls);
    if (!parsed.ok) {
      return { ok: false, status: 422, body: parsed };
    }
    await setPublicUrls(db, parsed.urls);
    return { ok: true, urls: parsed.urls };
  }
  return { ok: true, urls: await getPublicUrls(db) };
}

export type ReencryptRequestParse =
  | { ok: true; cursor: ReencryptCursor | null; limit: number }
  | { ok: false; error: string };

export function isReencryptStage(value: unknown): value is ReencryptStage {
  return typeof value === "string" &&
    (REENCRYPT_STAGES as readonly string[]).includes(value);
}

export function parseReencryptRequestBody(
  body: unknown,
): ReencryptRequestParse {
  if (body === null || body === undefined) {
    return { ok: true, cursor: null, limit: REENCRYPT_BATCH_SIZE };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "expected { cursor?, limit? }" };
  }

  const record = body as Record<string, unknown>;
  let limit = REENCRYPT_BATCH_SIZE;
  if (record.limit !== undefined) {
    if (
      typeof record.limit !== "number" || !Number.isInteger(record.limit) ||
      record.limit < 1
    ) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    // Cap to the server batch size so clients cannot request unbounded work.
    limit = Math.min(record.limit, REENCRYPT_BATCH_SIZE);
  }

  if (record.cursor === undefined || record.cursor === null) {
    return { ok: true, cursor: null, limit };
  }
  if (typeof record.cursor !== "object" || Array.isArray(record.cursor)) {
    return { ok: false, error: "cursor must be an object" };
  }

  const cursorObj = record.cursor as Record<string, unknown>;
  if (!isReencryptStage(cursorObj.stage)) {
    return { ok: false, error: "cursor.stage is required" };
  }

  const cursor: ReencryptCursor = { stage: cursorObj.stage };
  if (cursorObj.afterId !== undefined) {
    if (
      typeof cursorObj.afterId !== "string" || cursorObj.afterId.length === 0
    ) {
      return { ok: false, error: "cursor.afterId must be a non-empty string" };
    }
    cursor.afterId = cursorObj.afterId;
  }

  return { ok: true, cursor, limit };
}

export type PayloadBodyParse =
  | { ok: true; payload: unknown }
  | { ok: false; error: string };

export function parsePayloadBody(body: unknown): PayloadBodyParse {
  if (!body || typeof body !== "object" || !("payload" in body)) {
    return { ok: false, error: "expected { payload: unknown }" };
  }
  return { ok: true, payload: (body as { payload: unknown }).payload };
}

export type CellPurgeBatchParse =
  | { ok: true; serverIds: string[] }
  | { ok: false; error: string };

export function parseCellPurgeBatchBody(body: unknown): CellPurgeBatchParse {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { serverIds?: unknown }).serverIds) ||
    (body as { serverIds: unknown[] }).serverIds.length === 0 ||
    !(body as { serverIds: unknown[] }).serverIds.every(
      (id: unknown) => typeof id === "string" && id.length > 0,
    )
  ) {
    return {
      ok: false,
      error: "expected { serverIds: string[] } with at least one id",
    };
  }
  const serverIds = (body as { serverIds: string[] }).serverIds;
  if (serverIds.length > MAX_CELL_PURGE_BATCH_SIZE) {
    return {
      ok: false,
      error:
        `serverIds exceeds maximum batch size of ${MAX_CELL_PURGE_BATCH_SIZE}`,
    };
  }
  return { ok: true, serverIds };
}

export type SignupEnabledParse =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export function parseSignupEnabledBody(body: unknown): SignupEnabledParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "expected { enabled: boolean }" };
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "expected { enabled: boolean }" };
  }
  return { ok: true, enabled };
}

export type ServerMetricsLiveSettingsParse =
  | { ok: true; maxMinutes: number }
  | { ok: false; error: string };

/**
 * Shape-only parse of `PUT /settings/server-metrics-live` — the 0-or-5–240
 * range is enforced by the settings helper at write time.
 */
export function parseServerMetricsLiveSettingsBody(
  body: unknown,
): ServerMetricsLiveSettingsParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "expected { maxMinutes: number }" };
  }
  const maxMinutes = (body as { maxMinutes?: unknown }).maxMinutes;
  if (typeof maxMinutes !== "number" || !Number.isInteger(maxMinutes)) {
    return { ok: false, error: "expected { maxMinutes: number }" };
  }
  return { ok: true, maxMinutes };
}

const HOSTNAME_SOURCES = new Set<string>(INSTANCE_HOSTNAME_SOURCES);

export type ParsedInstanceHostname = {
  host: string;
  source: InstanceHostnameSource;
  uploadedCertId: string | null;
};

export function parseInstanceHostnamesBody(
  body: unknown,
): { ok: true; hostnames: ParsedInstanceHostname[] } | {
  ok: false;
  error: string;
} {
  if (!body || typeof body !== "object" || !("hostnames" in body)) {
    return { ok: false, error: "expected { hostnames: { host, source }[] }" };
  }
  const raw = (body as { hostnames: unknown }).hostnames;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "expected { hostnames: { host, source }[] }" };
  }
  const hostnames: ParsedInstanceHostname[] = [];
  for (const entry of raw) {
    const parsed = parseHostnameEntry(entry);
    if (!parsed.ok) return parsed;
    hostnames.push(parsed.hostname);
  }
  return { ok: true, hostnames };
}

function parseHostnameEntry(
  entry: unknown,
): { ok: true; hostname: ParsedInstanceHostname } | {
  ok: false;
  error: string;
} {
  if (!entry || typeof entry !== "object") {
    return { ok: false, error: "expected { hostnames: { host, source }[] }" };
  }
  const host = (entry as { host?: unknown }).host;
  const source = (entry as { source?: unknown }).source;
  const uploadedCertId = (entry as { uploadedCertId?: unknown }).uploadedCertId;
  if (
    typeof host !== "string" || typeof source !== "string" ||
    !HOSTNAME_SOURCES.has(source)
  ) {
    return { ok: false, error: "expected { hostnames: { host, source }[] }" };
  }
  if (
    uploadedCertId !== undefined && uploadedCertId !== null &&
    typeof uploadedCertId !== "string"
  ) {
    return { ok: false, error: "uploadedCertId must be a string or null" };
  }
  return {
    ok: true,
    hostname: {
      host,
      source: source as InstanceHostnameSource,
      uploadedCertId: typeof uploadedCertId === "string"
        ? uploadedCertId
        : null,
    },
  };
}

export function parseCertificateUploadBody(
  body: unknown,
): { ok: true; label: string; certPem: string; keyPem: string } | {
  ok: false;
  error: string;
} {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "expected { label, certPem, keyPem }" };
  }
  const label = (body as { label?: unknown }).label;
  const certPem = (body as { certPem?: unknown }).certPem;
  const keyPem = (body as { keyPem?: unknown }).keyPem;
  if (
    typeof label !== "string" || typeof certPem !== "string" ||
    typeof keyPem !== "string"
  ) {
    return { ok: false, error: "expected { label, certPem, keyPem }" };
  }
  if (label.trim() === "" || certPem.trim() === "" || keyPem.trim() === "") {
    return { ok: false, error: "expected { label, certPem, keyPem }" };
  }
  return { ok: true, label, certPem, keyPem };
}

export function parseCertificateHostnamesBody(
  body: unknown,
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || !("hosts" in body)) {
    return { ok: false, error: "expected { hosts: string[] }" };
  }
  const hosts = (body as { hosts: unknown }).hosts;
  if (
    !Array.isArray(hosts) || !hosts.every((host) => typeof host === "string")
  ) {
    return { ok: false, error: "expected { hosts: string[] }" };
  }
  return { ok: true, hosts };
}

function acmeUpdateValue(value: unknown): string | null | undefined {
  if (typeof value === "string" || value === null) return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

export function parseInstanceAcmeSettingsUpdates(
  body: unknown,
): { ok: true; updates: Record<string, string | null> } | {
  ok: false;
  error: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "expected a JSON object of setting keys" };
  }
  const updates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const stored = acmeUpdateValue(value);
    if (stored === undefined) {
      return { ok: false, error: `invalid value for ${key}` };
    }
    updates[key] = stored;
  }
  return { ok: true, updates };
}

export function parseEmailSettingsUpdates(
  body: unknown,
): Record<string, string | null> | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const updates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string" || value === null) updates[key] = value;
  }
  return updates;
}

export function resolvePerServerLimit(limitRaw: string | undefined): number {
  const limit = Number(limitRaw ?? 50);
  return Number.isFinite(limit) ? limit : 50;
}

export type PublicUrlsApplyWaitResult =
  | { kind: "done" }
  | { kind: "failed"; error: string }
  | { kind: "timeout" }
  | { kind: "error"; error: string };

export type PublicUrlsApplyHttpResult =
  | { status: 200; body: { ok: true; applied: true } }
  | { status: 500; body: { ok: false; applied: false; error: string } };

export function publicUrlsApplyWaitToResponse(
  result: PublicUrlsApplyWaitResult,
): PublicUrlsApplyHttpResult {
  switch (result.kind) {
    case "done":
      return { status: 200, body: { ok: true, applied: true } };
    case "timeout":
      return {
        status: 500,
        body: {
          ok: false,
          applied: false,
          error: "timeout waiting for daemon",
        },
      };
    case "failed":
    case "error":
      return {
        status: 500,
        body: { ok: false, applied: false, error: result.error },
      };
  }
}

/**
 * Ask the co-located daemon to apply public URLs and wait for a correlated reply.
 */
export async function waitForPublicUrlsApply(
  registry: DaemonCellRegistry,
  serverId: string,
  urlsOrPayload: string[] | PublicUrlsApplyPayload,
): Promise<PublicUrlsApplyWaitResult> {
  const payload = normalizePublicUrlsApply(urlsOrPayload);
  const requestId = generateRequestId();
  const traced = tracePublicUrlsPayload(payload);
  cellTrace("request-start", {
    requestId,
    serverId,
    kind: "public-urls-update",
    ...traced,
  });
  const envelope: DaemonOutboundEnvelope = {
    kind: "public-urls-update",
    deliveryId: generateDeliveryId(),
    requestId,
    at: nowTs(),
    urls: payload.urls,
    ...(payload.hostnames ? { hostnames: payload.hostnames } : {}),
    ...(payload.instanceAcme ? { instanceAcme: payload.instanceAcme } : {}),
  };
  cellTrace("request-enqueued", {
    requestId,
    serverId,
    kind: "public-urls-update",
    deliveryId: envelope.deliveryId,
    ...traced,
  });

  try {
    const record = await registry.getCell(serverId).createRequestAndWait(
      envelope,
      PUBLIC_URLS_APPLY_TIMEOUT_MS,
    );
    if (record.status === "done") {
      cellTrace("request-result", {
        requestId,
        serverId,
        kind: "public-urls-update",
        pendingStatus: record.status,
        resultStatus: "done",
      });
      return { kind: "done" };
    }
    if (record.status === "failed") {
      const error = record.error ?? "daemon reported failure";
      cellTrace("request-result", {
        requestId,
        serverId,
        kind: "public-urls-update",
        pendingStatus: record.status,
        resultStatus: "failed",
        error,
      });
      return { kind: "failed", error };
    }
    cellTrace("request-result", {
      requestId,
      serverId,
      kind: "public-urls-update",
      pendingStatus: record.status,
      resultStatus: "timeout",
      error: "timeout waiting for daemon",
    });
    return { kind: "timeout" };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    cellTrace("request-result", {
      requestId,
      serverId,
      kind: "public-urls-update",
      resultStatus: "error",
      error: errMessage,
    });
    return { kind: "error", error: errMessage };
  }
}
