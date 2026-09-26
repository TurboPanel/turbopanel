/**
 * Host-free stand-in for Postgres applying the `server.daemon` patches in
 * `features/servers/daemon-jsonb-write.ts`, for suites whose db double
 * captures `.set({ daemon })`. Test-only: `daemon-jsonb-write.test.ts` pins
 * it to what Postgres actually does for the same inputs.
 */
import {
  FEATURES_PATCH_MARKER,
  PROJECTION_PATCH_MARKER,
} from "../features/servers/daemon-jsonb-write.ts";
import type { ServerDaemonJsonb } from "../features/servers/daemon-state.ts";

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
