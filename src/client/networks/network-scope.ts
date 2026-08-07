import type { Context } from 'hono'

export function assertNetworkKindScope(
  c: Context,
  kind: string,
  datacenterId: string | null | undefined,
  serverId: string | null | undefined,
): Response | null {
  const hasDatacenter = datacenterId !== undefined && datacenterId !== null
  const hasServer = serverId !== undefined && serverId !== null

  if (hasDatacenter && hasServer) {
    return c.json({ error: 'network_single_scope_conflict' }, 400)
  }

  if (kind === 'datacenter') {
    if (!hasDatacenter) {
      return c.json({ error: 'network_scope_required' }, 400)
    }
    if (hasServer) {
      return c.json({ error: 'network_single_scope_conflict' }, 400)
    }
    return null
  }

  if (kind === 'server') {
    if (!hasServer) {
      return c.json({ error: 'network_scope_required' }, 400)
    }
    if (hasDatacenter) {
      return c.json({ error: 'network_single_scope_conflict' }, 400)
    }
    return null
  }

  if (hasDatacenter || hasServer) {
    return c.json({ error: 'network_single_scope_conflict' }, 400)
  }
  return null
}

export type NetworkCreateFields = {
  kind: string
  datacenterId: string | null | undefined
  serverId: string | null | undefined
  displayName: string | null
  cidr: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

export function buildNetworkCreateValues(input: {
  organizationId: string
} & NetworkCreateFields) {
  return {
    organizationId: input.organizationId,
    kind: input.kind,
    ...(input.datacenterId !== undefined ? { datacenterId: input.datacenterId } : {}),
    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
    ...(input.displayName !== null ? { displayName: input.displayName } : {}),
    ...(input.cidr !== null ? { cidr: input.cidr } : {}),
    ...(input.metadata !== null ? { metadata: input.metadata } : {}),
    ...(input.options !== null ? { options: input.options } : {}),
  }
}
