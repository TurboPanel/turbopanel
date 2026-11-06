/**
 * The error every TurboFabric allocator throws when a pool runs out or a
 * needed row is missing. Kept apart so allocators outside `fabric-records.ts`
 * (the server container range) throw the same kinds.
 */

export type FabricAllocationErrorKind =
  | 'fabric_address_pool_exhausted'
  | 'fabric_prefix_pool_exhausted'
  /** Compose-bridge subnet pool (table `subnet`); error code kept as-is. */
  | 'fabric_segment_pool_exhausted'
  | 'relay_missing'
  | 'relay_endpoint_unavailable'

const ALLOCATION_MESSAGES: Record<FabricAllocationErrorKind, string> = {
  fabric_address_pool_exhausted: 'TurboFabric address pool exhausted',
  fabric_prefix_pool_exhausted: 'TurboFabric prefix address pool exhausted',
  fabric_segment_pool_exhausted: 'TurboFabric segment address pool exhausted',
  relay_missing: 'TurboFabric relay missing',
  relay_endpoint_unavailable: 'TurboFabric relay endpoint unavailable',
}

export class FabricAllocationError extends Error {
  readonly kind: FabricAllocationErrorKind

  constructor(kind: FabricAllocationErrorKind, message = ALLOCATION_MESSAGES[kind]) {
    super(message)
    this.name = 'FabricAllocationError'
    this.kind = kind
  }
}
