/**
 * Pure, timer-free per-connection inbound flood gate.
 *
 * Canonical mirror of `#allowInboundMessage` / `#inboundRate` in
 * `src/daemon/cell/do.ts` — keep the window math and rejection semantics in sync
 * when either side changes. Deno wires this for `/ws/daemon/v1`; the Durable
 * Object keeps its private Map so hibernation / attachment lifecycle stays local.
 */

export type InboundWindowGate = {
  allow(connectionId: string): boolean
  release(connectionId: string): void
}

export function createInboundWindowGate(
  limit: number,
  windowMs: number,
): InboundWindowGate {
  const windows = new Map<string, { windowStartMs: number; count: number }>()

  return {
    allow(connectionId: string): boolean {
      const now = Date.now()
      const existing = windows.get(connectionId)
      if (!existing || now - existing.windowStartMs >= windowMs) {
        windows.set(connectionId, { windowStartMs: now, count: 1 })
        return true
      }
      existing.count += 1
      if (existing.count > limit) {
        return false
      }
      return true
    },
    release(connectionId: string): void {
      windows.delete(connectionId)
    },
  }
}
