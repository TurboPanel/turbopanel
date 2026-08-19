/**
 * Pure helpers for system operate routes (extracted for host-free coverage).
 */

import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
} from './hierarchy.ts'

export const SYSTEM_OPERATE_COMPONENTS = [
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
] as const

export type SystemOperateComponent = (typeof SYSTEM_OPERATE_COMPONENTS)[number]

export function isSystemOperateComponent(
  value: string,
): value is SystemOperateComponent {
  return (SYSTEM_OPERATE_COMPONENTS as readonly string[]).includes(value)
}

export type SystemRestartFailurePayload =
  | { error: 'system_component_not_provisioned'; status: 404 }
  | { error: 'system_reconcile_unavailable'; status: 503 }

export function mapSystemRestartFailure(
  reason: string,
): SystemRestartFailurePayload {
  if (reason === 'not_provisioned') {
    return { error: 'system_component_not_provisioned', status: 404 }
  }
  return { error: 'system_reconcile_unavailable', status: 503 }
}

export function systemRestartQueuedResponse(params: {
  commandId: string
  serverId: string
}) {
  return {
    ok: true as const,
    commandId: params.commandId,
    status: 'queued' as const,
    serverId: params.serverId,
  }
}
