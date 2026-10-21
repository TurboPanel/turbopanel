/**
 * Whether a bound app is placed off the hosts that run the managed cluster.
 * Those consumers dial the engine's private listener, so apply must publish it.
 */

export function hasRemoteConsumerServers(
  memberServerIds: readonly string[],
  consumerServerIds: readonly string[]
): boolean {
  const members = new Set(memberServerIds)
  return consumerServerIds.some((id) => id.length > 0 && !members.has(id))
}
