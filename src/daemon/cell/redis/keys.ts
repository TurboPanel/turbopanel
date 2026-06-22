export const OUTBOX_GROUP = 'daemon'
export const LEASE_TTL_MS = 45_000

export function metaKey(serverId: string): string {
  return `tp:cell:${serverId}:meta`
}

export function snapshotKey(serverId: string): string {
  return `tp:cell:${serverId}:snapshot`
}

export function outboxKey(serverId: string): string {
  return `tp:cell:${serverId}:outbox`
}

export function eventsKey(serverId: string): string {
  return `tp:cell:${serverId}:events`
}

export function requestsKey(serverId: string): string {
  return `tp:cell:${serverId}:requests`
}

export function requestKey(serverId: string, requestId: string): string {
  return `tp:cell:${serverId}:request:${requestId}`
}

export function leaseKey(serverId: string): string {
  return `tp:cell:${serverId}:lease:daemon-socket`
}

export function connKey(serverId: string, connectionId: string): string {
  return `tp:cell:${serverId}:conn:${connectionId}`
}

export function onlineSetKey(): string {
  return 'tp:cell:online'
}

export function challengeKey(challengeId: string): string {
  return `tp:daemon:challenge:${challengeId}`
}
