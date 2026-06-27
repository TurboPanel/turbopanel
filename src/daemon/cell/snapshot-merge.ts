import type { DaemonCellSnapshot } from "./contracts.ts";

/** Live presence fields maintained in cell meta, not the persisted snapshot blob. */
const PRESENCE_FIELDS = [
  "connected",
  "remoteAddress",
  "hostname",
  "machineId",
  "sessionId",
  "keyId",
  "connectedAt",
  "lastSeenAt",
] as const satisfies ReadonlyArray<keyof DaemonCellSnapshot>;

/**
 * Overlay runtime presence from cell meta onto a persisted snapshot projection.
 * Stored snapshots retain addresses/metadata; meta wins for connection state.
 */
export function mergeSnapshotPresence(
  stored: DaemonCellSnapshot,
  meta: DaemonCellSnapshot,
): DaemonCellSnapshot {
  const merged: DaemonCellSnapshot = { ...stored };
  for (const field of PRESENCE_FIELDS) {
    const value = meta[field];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[field] = value;
    }
  }
  if (meta.updatedAt > stored.updatedAt) {
    merged.updatedAt = meta.updatedAt;
  }
  return merged;
}
