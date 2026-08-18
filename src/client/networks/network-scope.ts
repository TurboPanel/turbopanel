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

  // docker: optional serverId (host-local external network); never datacenterId
  if (hasDatacenter) {
    return c.json({ error: 'network_single_scope_conflict' }, 400)
  }
  return null
}

/** Site subnets (`kind='datacenter'`) require a CIDR; docker does not. */
export function assertDatacenterCidr(
  c: Context,
  kind: string,
  cidr: string | null,
): Response | null {
  if (kind === 'datacenter' && cidr === null) {
    return c.json({ error: 'network_cidr_required' }, 400)
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
    ...(input.displayName !== null ? { name: input.displayName } : {}),
    ...(input.cidr !== null ? { cidr: input.cidr } : {}),
    ...(input.metadata !== null ? { metadata: input.metadata } : {}),
    ...(input.options !== null ? { options: input.options } : {}),
  }
}
