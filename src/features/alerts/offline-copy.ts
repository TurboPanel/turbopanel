/** Operator-facing copy for sweep demotions. Shared by the daemon cell. */

export function massDisconnectText(
  staleCount: number,
  connectedBefore: number,
): string {
  return `Mass disconnect: ${staleCount} of ${connectedBefore} connected servers went offline in one sweep — suspect a shared cause (daemon release, ingress, or cell outage) rather than ${staleCount} unrelated hosts`
}

export function serverOfflineText(serverId: string): string {
  return `Server ${serverId} stopped answering and has been marked offline`
}
