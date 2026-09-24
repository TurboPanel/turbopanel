/**
 * Atomic `server.daemon` writers for the two projections that share the column.
 *
 * Hello advertises `projection.features`. Connect, build, and update writes
 * replace the rest of the projection. Each statement reads the row it updates,
 * so a commit that lands between the other writer's SELECT and UPDATE is kept:
 * hello sets only `projection.features`, and the projection write copies that
 * key off the current row when it is already present.
 */
import { type SQL, sql } from "drizzle-orm";
import type { ServerDaemonJsonb } from "../../features/servers/daemon-state.ts";
import { server } from "../../db/schema.ts";

const FEATURES_PATCH_MARKER = "daemon-features-patch";
const PROJECTION_PATCH_MARKER = "daemon-projection-patch";

/** `jsonb_set` only `{projection,features}` on the row being updated. */
export function daemonFeaturesColumnPatch(features: readonly string[]): SQL {
  const featuresJson = JSON.stringify([...features]);
  return sql`/* ${sql.raw(FEATURES_PATCH_MARKER)} */ jsonb_set(
    COALESCE(${server.daemon}, '{}'::jsonb) || jsonb_build_object(
      'projection',
      COALESCE(${server.daemon}->'projection', '{}'::jsonb)
    ),
    '{projection,features}',
    ${featuresJson}::jsonb,
    true
  )`;
}

/**
 * Replace the projection, but keep `projection.features` from the current
 * row when that key exists. A missing key falls back to `snapshot`.
 */
export function daemonProjectionColumnPatch(snapshot: ServerDaemonJsonb): SQL {
  const snapshotJson = JSON.stringify(snapshot);
  return sql`/* ${sql.raw(PROJECTION_PATCH_MARKER)} */ CASE
    WHEN ${server.daemon} #> '{projection,features}' IS NOT NULL THEN jsonb_set(
      (${snapshotJson}::jsonb #- '{projection,features}') || jsonb_build_object(
        'projection',
        COALESCE((${snapshotJson}::jsonb #- '{projection,features}')->'projection', '{}'::jsonb)
      ),
      '{projection,features}',
      ${server.daemon} #> '{projection,features}',
      true
    )
    ELSE ${snapshotJson}::jsonb
  END`;
}

/**
 * Apply {@link daemonFeaturesColumnPatch} / {@link daemonProjectionColumnPatch}
 * the way Postgres would, for host-free mocks. A plain object is returned
 * unchanged.
 */
export function materializeDaemonJsonbWrite(
  live: ServerDaemonJsonb | null,
  assigned: unknown,
): ServerDaemonJsonb | null {
  if (assigned == null) return null;
  const chunks = sqlQueryChunks(assigned);
  if (!chunks) return assigned as ServerDaemonJsonb;
  const flat = flattenSql(chunks);
  if (flat.text.includes(FEATURES_PATCH_MARKER)) {
    return applyFeaturesPatch(live, flat.params);
  }
  if (flat.text.includes(PROJECTION_PATCH_MARKER)) {
    return applyProjectionPatch(live, flat.params);
  }
  return assigned as ServerDaemonJsonb;
}

function applyFeaturesPatch(
  live: ServerDaemonJsonb | null,
  params: readonly unknown[],
): ServerDaemonJsonb {
  const parsed = jsonParam(params, "[");
  const features = stringList(parsed);
  return {
    ...live,
    projection: {
      ...live?.projection,
      features,
    },
  };
}

function applyProjectionPatch(
  live: ServerDaemonJsonb | null,
  params: readonly unknown[],
): ServerDaemonJsonb {
  const parsed = jsonParam(params, "{");
  const snapshot = isDaemonColumn(parsed) ? parsed : {};
  const features = live?.projection?.features;
  if (features === undefined) return snapshot;
  return {
    ...snapshot,
    projection: {
      ...snapshot.projection,
      features: [...features],
    },
  };
}

function stringList(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const features: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") features.push(entry);
  }
  return features;
}

function jsonParam(params: readonly unknown[], prefix: "{" | "["): unknown {
  for (const param of params) {
    if (typeof param !== "string" || !param.startsWith(prefix)) continue;
    return JSON.parse(param);
  }
  return undefined;
}

function isDaemonColumn(value: unknown): value is ServerDaemonJsonb {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlQueryChunks(value: unknown): unknown[] | undefined {
  if (
    typeof value !== "object" || value === null || !("queryChunks" in value)
  ) {
    return undefined;
  }
  const chunks = (value as { queryChunks: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks : undefined;
}

function flattenSql(
  chunks: readonly unknown[],
): { text: string; params: unknown[] } {
  const text: string[] = [];
  const params: unknown[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      params.push(value);
      return;
    }
    const nested = sqlQueryChunks(value);
    if (nested) {
      for (const chunk of nested) visit(chunk);
      return;
    }
    if (typeof value !== "object" || value === null || !("value" in value)) {
      return;
    }
    const parts = (value as { value: unknown }).value;
    if (!Array.isArray(parts)) return;
    let chunkText = "";
    for (const part of parts) {
      if (typeof part !== "string") return;
      chunkText += part;
    }
    text.push(chunkText);
  };
  for (const chunk of chunks) visit(chunk);
  return { text: text.join(""), params };
}
