/**
 * Reserved deploy variable key helpers.
 *
 * Pure — no DB / Deno / Workers APIs. `TURBOPANEL_*` identity keys stay
 * reserved (stripped from user variables) but are no longer auto-injected into
 * prepared compose; a future feature will let operators opt into them.
 */

import { RESERVED_DEPLOY_VARIABLE_KEYS } from '../naming.ts'
import type { DeployVariableEntry } from './apply-variables.ts'

/** Drop any entries whose key is in {@link RESERVED_DEPLOY_VARIABLE_KEYS}. */
export function stripReservedDeployVariableKeys(
  entries: readonly DeployVariableEntry[],
): DeployVariableEntry[] {
  return entries.filter((entry) => !RESERVED_DEPLOY_VARIABLE_KEYS.has(entry.key))
}

/**
 * Drop entries whose keys are owned by a binding. Used after hosting merge so
 * hosting-scope user variables cannot shadow binding materialization.
 */
export function stripBindingOwnedKeys(
  entries: readonly DeployVariableEntry[],
  bindingOwnedKeys: ReadonlySet<string>,
): DeployVariableEntry[] {
  if (bindingOwnedKeys.size === 0) return [...entries]
  return entries.filter((entry) => !bindingOwnedKeys.has(entry.key))
}
