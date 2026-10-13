/**
 * Placement value sets, pinned to the `placement` CHECK constraints by
 * `src/db/enum-checks.test.ts`. Kept import-free so that test stays light.
 */
export const PLACEMENT_STATES = ['pending', 'present', 'retiring', 'absent'] as const
export type PlacementState = (typeof PLACEMENT_STATES)[number]

export const PLACEMENT_SOURCES = ['compose', 'manual', 'storage'] as const
export type PlacementSource = (typeof PLACEMENT_SOURCES)[number]
