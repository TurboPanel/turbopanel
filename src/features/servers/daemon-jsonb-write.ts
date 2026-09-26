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
import { server } from "../../db/schema.ts";
import type { ServerDaemonJsonb } from "./daemon-state.ts";

/** Comment markers the host-free simulator (`test-fixtures/daemon-jsonb-simulator.ts`) keys on. */
export const FEATURES_PATCH_MARKER = "daemon-features-patch";
export const PROJECTION_PATCH_MARKER = "daemon-projection-patch";

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
