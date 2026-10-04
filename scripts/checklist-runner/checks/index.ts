/**
 * The check registry, in run order: read-only first, then panel-object
 * checks, then host-affecting ones (which only run with --allow-host-affecting).
 */
import type { Check } from '../types.ts'
import { AUTH_CHECKS } from './auth.ts'
import { DEPLOY_CHECKS } from './deploys.ts'
import { FLEET_HOST_CHECKS } from './fleet-host.ts'
import { MANAGED_CHECKS } from './managed.ts'
import { OBJECT_CHECKS } from './objects.ts'
import { READONLY_CHECKS } from './readonly.ts'

export const REGISTRY: readonly Check[] = [
  ...READONLY_CHECKS,
  ...OBJECT_CHECKS,
  ...AUTH_CHECKS,
  ...FLEET_HOST_CHECKS,
  ...DEPLOY_CHECKS,
  ...MANAGED_CHECKS,
]
