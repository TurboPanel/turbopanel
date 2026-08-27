/**
 * Persist Organization-CA-signed managed leaf expiry + signing generation.
 *
 * `leaf` is successfully **deployed** leaf state, not payload generation.
 * `issueLeafCertificate` itself is fire-and-forget; mint sites stash the new
 * leaf on command metadata (`pendingTlsLeaf`) and the command consumer upserts
 * only after `managed.apply` / `managed.ingress.reconcile` succeed. Re-issuance
 * overwrites via the partial unique indexes on `leaf`
 * (`uniq_leaf_ingress_server` / `uniq_leaf_engine_replica`) — no history.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { leaf } from "../../lib/db/schema.ts";
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from "../../lib/tls/self-signed.ts";

const MS_PER_DAY = 86_400_000;

/** Command-metadata key for a minted leaf waiting on apply / ingress success. */
export const PENDING_TLS_LEAF_METADATA_KEY = "pendingTlsLeaf";

export type TlsLeafKind = "ingress" | "engine";

export type UpsertTlsLeafTrackingParams = Readonly<{
  kind: TlsLeafKind;
  organizationId: string;
  serverId: string;
  caId: string;
  caGeneration: number;
  notAfter: string;
  issuedAt?: string;
  /** Engine leaves only. */
  managedId?: string;
  /** Engine leaves only. */
  replicaId?: string;
}>;

/** `notAfter` for a leaf minted now at the Organization CA default lifetime. */
export function organizationCaLeafNotAfterIso(issuedAtMs = Date.now()): string {
  return new Date(
    issuedAtMs + ORGANIZATION_CA_LEAF_VALID_DAYS * MS_PER_DAY,
  ).toISOString();
}

/** Wrap minted tracking params for `createCommandRecord({ metadata })`. */
export function pendingTlsLeafMetadata(
  params: UpsertTlsLeafTrackingParams,
): Record<string, unknown> {
  return { [PENDING_TLS_LEAF_METADATA_KEY]: { ...params } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parse a raw `pendingTlsLeaf` object (standby-apply entries store the params
 * directly rather than the metadata wrapper).
 */
export function parsePendingTlsLeafValue(
  value: unknown,
): UpsertTlsLeafTrackingParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "ingress" && record.kind !== "engine") return null;
  if (
    !isNonEmptyString(record.organizationId) ||
    !isNonEmptyString(record.serverId) ||
    !isNonEmptyString(record.caId) ||
    !isNonEmptyString(record.notAfter) ||
    typeof record.caGeneration !== "number" ||
    !Number.isFinite(record.caGeneration)
  ) {
    return null;
  }

  let issuedAt: string | undefined;
  if (record.issuedAt !== undefined) {
    if (!isNonEmptyString(record.issuedAt)) return null;
    issuedAt = record.issuedAt;
  }

  if (record.kind === "ingress") {
    return {
      kind: "ingress",
      organizationId: record.organizationId,
      serverId: record.serverId,
      caId: record.caId,
      caGeneration: record.caGeneration,
      notAfter: record.notAfter,
      ...(issuedAt === undefined ? {} : { issuedAt }),
    };
  }

  if (!isNonEmptyString(record.managedId) || !isNonEmptyString(record.replicaId)) {
    return null;
  }
  return {
    kind: "engine",
    organizationId: record.organizationId,
    serverId: record.serverId,
    caId: record.caId,
    caGeneration: record.caGeneration,
    notAfter: record.notAfter,
    managedId: record.managedId,
    replicaId: record.replicaId,
    ...(issuedAt === undefined ? {} : { issuedAt }),
  };
}

/** Read `pendingTlsLeaf` from command metadata. Invalid / missing → `null`. */
export function parsePendingTlsLeafTracking(
  metadata: unknown,
): UpsertTlsLeafTrackingParams | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  return parsePendingTlsLeafValue(
    (metadata as Record<string, unknown>)[PENDING_TLS_LEAF_METADATA_KEY],
  );
}

/**
 * Upsert `leaf` from command metadata. Returns `false` when no valid
 * pending leaf is present (enqueue/terminal failure must never call this).
 */
export async function commitPendingTlsLeafTracking(
  db: Db,
  metadata: unknown,
): Promise<boolean> {
  const pending = parsePendingTlsLeafTracking(metadata);
  if (!pending) return false;
  await upsertTlsLeafTracking(db, pending);
  return true;
}

/**
 * Insert or overwrite the tracking row for one **deployed** leaf.
 * Ingress is keyed on `serverId`; engine is keyed on `replicaId`.
 */
export async function upsertTlsLeafTracking(
  db: Db,
  params: UpsertTlsLeafTrackingParams,
): Promise<void> {
  const issuedAt = params.issuedAt ?? new Date().toISOString();
  if (params.kind === "ingress") {
    await db
      .insert(leaf)
      .values({
        organizationId: params.organizationId,
        serverId: params.serverId,
        kind: "ingress",
        managedId: null,
        replicaId: null,
        caId: params.caId,
        caGeneration: params.caGeneration,
        notAfter: params.notAfter,
        issuedAt,
      })
      .onConflictDoUpdate({
        target: leaf.serverId,
        targetWhere: sql`${leaf.kind} = 'ingress'`,
        set: {
          organizationId: params.organizationId,
          caId: params.caId,
          caGeneration: params.caGeneration,
          notAfter: params.notAfter,
          issuedAt,
        },
      });
    return;
  }

  if (!params.replicaId || !params.managedId) {
    throw new TypeError("engine leaf tracking requires replicaId and managedId");
  }

  await db
    .insert(leaf)
    .values({
      organizationId: params.organizationId,
      serverId: params.serverId,
      kind: "engine",
      managedId: params.managedId,
      replicaId: params.replicaId,
      caId: params.caId,
      caGeneration: params.caGeneration,
      notAfter: params.notAfter,
      issuedAt,
    })
    .onConflictDoUpdate({
      target: leaf.replicaId,
      targetWhere: sql`${leaf.kind} = 'engine'`,
      set: {
        organizationId: params.organizationId,
        serverId: params.serverId,
        managedId: params.managedId,
        caId: params.caId,
        caGeneration: params.caGeneration,
        notAfter: params.notAfter,
        issuedAt,
      },
    });
}
