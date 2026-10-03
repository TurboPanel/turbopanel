/**
 * What the compose document itself asks for, folded into the org / server
 * ceiling check.
 *
 * Service settings are applied over the compose document at deploy time (see
 * `applyResourcesToComposeService`), so the effective request for a service is
 * the settings value when one is set, otherwise the document's own limit.
 * Reservations count when they are larger than the limit. `deploy.replicas`
 * multiplies. A service that asks for nothing contributes nothing.
 */

import type { ResolvedResources } from '../compose/ir.ts'

type Resources = { cpus?: number; memoryBytes?: number }

const MEMORY_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** A compose CPU quantity: a number or a numeric string. Anything else is not counted. */
export function parseComposeCpus(value: unknown): number | undefined {
  if (typeof value === 'number') return positiveOrUndefined(value)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return positiveOrUndefined(Number(value.trim()))
}

/** A compose byte quantity: a number of bytes or `<n>[b|k|m|g|kb|mb|gb]`. Anything else is not counted. */
export function parseComposeBytes(value: unknown): number | undefined {
  if (typeof value === 'number') return positiveOrUndefined(Math.floor(value))
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(value.trim().toLowerCase())
  if (!match) return undefined
  const multiplier = match[2] === '' ? 1 : MEMORY_UNITS[match[2]!]
  if (multiplier === undefined) return undefined
  return positiveOrUndefined(Math.floor(Number(match[1]) * multiplier))
}

function largest(values: ReadonlyArray<number | undefined>): number | undefined {
  const present = values.filter((entry): entry is number => entry !== undefined)
  return present.length === 0 ? undefined : Math.max(...present)
}

function deployBlock(service: Record<string, unknown>, key: 'limits' | 'reservations') {
  const deploy = isRecord(service.deploy) ? service.deploy : {}
  const resources = isRecord(deploy.resources) ? deploy.resources : {}
  return isRecord(resources[key]) ? resources[key] : {}
}

function replicaMultiplier(service: Record<string, unknown>): number {
  const deploy = isRecord(service.deploy) ? service.deploy : {}
  const replicas = deploy.replicas
  return typeof replicas === 'number' && Number.isInteger(replicas) && replicas > 1 ? replicas : 1
}

/** One service's effective request, per replica, before the replica multiplier. */
function effectiveRequest(
  service: Record<string, unknown>,
  settings: ResolvedResources | undefined
): Resources {
  const limits = deployBlock(service, 'limits')
  const reservations = deployBlock(service, 'reservations')
  const cpuLimit =
    settings?.cpus ?? largest([parseComposeCpus(service.cpus), parseComposeCpus(limits.cpus)])
  const memoryLimit =
    settings?.memoryBytes ??
    largest([parseComposeBytes(service.mem_limit), parseComposeBytes(limits.memory)])
  const cpus = largest([cpuLimit, parseComposeCpus(reservations.cpus)])
  const memoryBytes = largest([
    memoryLimit,
    parseComposeBytes(service.mem_reservation),
    parseComposeBytes(reservations.memory),
    settings?.memoryReservationBytes,
  ])
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
  }
}

/**
 * Per-service effective resources for the ceiling check, keyed by compose
 * service name. Services only present in `settingsByName` (no document entry)
 * keep their settings values unchanged.
 */
export function effectiveServiceResources(
  composeServices: unknown,
  settingsByName: ReadonlyMap<string, ResolvedResources | undefined>
): Map<string, Resources> {
  const services = isRecord(composeServices) ? composeServices : {}
  const result = new Map<string, Resources>()
  for (const [name, settings] of settingsByName) {
    if (!isRecord(services[name])) result.set(name, settings ?? {})
  }
  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw)) continue
    const request = effectiveRequest(raw, settingsByName.get(name))
    const times = replicaMultiplier(raw)
    result.set(name, {
      ...(request.cpus === undefined ? {} : { cpus: request.cpus * times }),
      ...(request.memoryBytes === undefined ? {} : { memoryBytes: request.memoryBytes * times }),
    })
  }
  return result
}
