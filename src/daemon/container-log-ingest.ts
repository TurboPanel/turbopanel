/**
 * Body parsing and organization resolution for
 * `POST /api/daemon/v1/logs/containers`.
 *
 * Kept beside the route rather than inside it so the parsing rules stay
 * unit-testable without a Hono context or a live database, matching
 * `execution-log-ingest.ts`.
 *
 * **Tenancy rule.** Nothing identifying is trusted from the body. The daemon
 * sends `serverId` / `organizationId` for wire-shape parity with
 * `ContainerLogEvent`, and both are overwritten here: `serverId` comes from the
 * verified JWT `sub`, and `organizationId` from that server's row. A daemon
 * therefore cannot write a line into another tenant's table even if it tries.
 * See `../lib/container-logs/AGENTS.md` → Tenancy.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db.ts";
import { organization, server } from "../lib/db/schema.ts";
import { parseOrganizationOptions } from "../lib/organization-options.ts";
import { resolveContainerLogsEnabled } from "../lib/container-logs/org-settings.ts";
import {
  type ContainerLogEvent,
  type ContainerLogStream,
  MAX_CONTAINER_LOG_INGEST_BATCH,
  truncateContainerLogMessage,
} from "../lib/container-logs/types.ts";

/**
 * Whole-request byte budget, read (and aborted) before JSON parsing.
 *
 * Sized as a full batch of typical lines plus JSON envelope overhead, not as
 * `MAX_CONTAINER_LOG_INGEST_BATCH × MAX_CONTAINER_LOG_MESSAGE_BYTES` — that
 * product is 160 MB and would be a denial-of-service budget, not a limit. A
 * daemon that fills its lines has to send more, smaller batches.
 */
export const MAX_CONTAINER_LOG_BATCH_BODY_BYTES = 4 * 1024 * 1024;

/** Ingest is stamped, not trusted: these fields are supplied by the route. */
export type ContainerLogIngestIdentity = {
  serverId: string;
  organizationId: string;
};

export type ContainerLogBatchBodyResult =
  | { ok: true; events: ContainerLogEvent[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStream(value: unknown): ContainerLogStream | null {
  return value === "stdout" || value === "stderr" ? value : null;
}

/** ISO-8601 in, ISO-8601 out. An unparseable stamp is rejected, not guessed. */
function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Validate `{ events: [...] }` and stamp the authenticated identity onto every
 * row. A single malformed event rejects the whole batch: a daemon that sends
 * garbage has a bug, and silently keeping the good half would hide it.
 */
export function parseContainerLogBatchBody(
  body: unknown,
  identity: ContainerLogIngestIdentity,
): ContainerLogBatchBodyResult {
  if (!isRecord(body)) return { ok: false, error: "invalid batch" };
  const raw = body.events;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "events must be an array" };
  }
  if (raw.length > MAX_CONTAINER_LOG_INGEST_BATCH) {
    return { ok: false, error: "batch too large" };
  }

  const events: ContainerLogEvent[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, error: "invalid event" };
    const timestamp = parseTimestamp(entry.timestamp);
    if (!timestamp) return { ok: false, error: "invalid timestamp" };
    const stream = parseStream(entry.stream);
    if (!stream) return { ok: false, error: "stream must be stdout or stderr" };
    const containerId = optionalId(entry.containerId);
    if (!containerId) return { ok: false, error: "containerId is required" };
    if (typeof entry.message !== "string") {
      return { ok: false, error: "message must be a string" };
    }
    events.push({
      timestamp,
      // Never `entry.organizationId` / `entry.serverId` — see the module doc.
      organizationId: identity.organizationId,
      serverId: identity.serverId,
      environmentId: optionalId(entry.environmentId),
      serviceId: optionalId(entry.serviceId),
      containerId,
      stream,
      message: truncateContainerLogMessage(entry.message),
    });
  }
  return { ok: true, events };
}


/** Owning tenant plus that tenant's retention switch, resolved in one join. */
export type ContainerLogIngestTarget = {
  organizationId: string;
  /**
   * `organization.options.containerLogsEnabled` — the **authoritative**
   * retention gate. The runtime store only says whether a backend exists; this
   * says whether this tenant asked (and is billed) for retention.
   */
  retentionEnabled: boolean;
};

/**
 * Resolve the owning organization *and* its retention switch for an
 * authenticated daemon's server.
 *
 * One join per ingest request — the same cost as the org-only lookup it
 * replaces. It is deliberately **not** the TTL-cached presence read
 * (`loadServerContainerLogsEnabledCached`): the presence ack is allowed to lag
 * a toggle by a cache window because it only decides when a daemon stops
 * streaming, whereas a write is what actually persists tenant output and must
 * honour the switch as of right now. A daemon that has not yet seen the "off"
 * ack keeps posting for a while; those batches are dropped here.
 *
 * Returns `null` when the row is missing or has no organization — an unowned
 * server has no tenant to attribute output to, so the route rejects rather
 * than inventing one.
 */
export async function loadContainerLogIngestTarget(
  db: Db,
  serverId: string,
): Promise<ContainerLogIngestTarget | null> {
  const rows = await db
    .select({
      organizationId: server.organizationId,
      options: organization.options,
    })
    .from(server)
    .leftJoin(organization, eq(server.organizationId, organization.id))
    .where(eq(server.id, serverId))
    .limit(1);
  const row = rows[0];
  if (!row?.organizationId) return null;
  return {
    organizationId: row.organizationId,
    retentionEnabled: resolveContainerLogsEnabled(
      parseOrganizationOptions(row.options),
    ),
  };
}
