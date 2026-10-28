/**
 * A tunnel has an owning organization and a routing organization (the one
 * whose servers and sites it carries). Cross-organization hosting is not
 * allowed yet, so the two must match. This is enforced here, not by a
 * database constraint, so the rule can be relaxed later without a migration.
 */
export class TunnelOrganizationError extends Error {
  constructor() {
    super('A tunnel can only carry sites and servers of the organization that owns it')
    this.name = 'TunnelOrganizationError'
  }
}

export function assertSameHostingOrganization(
  organizationId: string,
  routingOrganizationId: string
): void {
  if (organizationId !== routingOrganizationId) throw new TunnelOrganizationError()
}
