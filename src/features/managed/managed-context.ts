import type { ManagedEngineSpec } from './index.ts'
import type { ManagedOrganizationDefaults } from './org-defaults.ts'

/**
 * Request-scoped managed environment context. Built by the client surface;
 * feature helpers consume the type only.
 */
export type ManagedContext = {
  environmentId: string
  projectId: string
  envDisplayName: string | null
  catalogCode: string
  spec: ManagedEngineSpec
  /**
   * The environment's *current* placement pin — **not** necessarily the host
   * that owns an existing managed service. Once a `managed` row exists,
   * `managed.server_id` is the source of truth for where the engine actually
   * runs; this field may be `null` (placement cleared) or point at a
   * different server than `managed.server_id` after the environment's
   * compose placement moves independently. Routes operating on an existing
   * row must resolve their target via `resolveManagedTargetServerId`,
   * not by reading this field directly. It remains required (via
   * `requireManagedCreateServerId`) only when creating a brand-new
   * managed row.
   */
  serverId: string | null
  organizationId: string
  /**
   * Org-wide managed defaults inherited by services with no override
   * (`organization.options.managedDatabase`). Resolve an effective value with
   * the matching `resolveManaged*` helper rather than reading a service field
   * directly.
   */
  orgDefaults: ManagedOrganizationDefaults
}
