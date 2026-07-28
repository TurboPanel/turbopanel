import { DOCKER_RESOURCE_NAME_RE } from '../naming.ts'
import { isValidHostname } from './hostname.ts'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployStorageMaterial,
} from './schemas.ts'

const STORAGE_KINDS = new Set([
  'docker_volume',
  'bind_mount',
  'file',
  'directory',
])

export function validateDeployPathPrefix(pathPrefix: string | undefined): boolean {
  if (pathPrefix === undefined) return true
  return pathPrefix.startsWith('/')
}

/** Treat `/`, blank, and omitted as catch-all (no path router). */
export function normalizeDeployPathPrefix(
  pathPrefix: string | undefined,
): string | undefined {
  if (pathPrefix === undefined) return undefined
  const trimmed = pathPrefix.trim()
  if (trimmed.length === 0 || trimmed === '/') return undefined
  return trimmed
}

export function pathPrefixHasUnsupportedCharacters(pathPrefix: string): boolean {
  return pathPrefix.includes('`') || /[\r\n]/.test(pathPrefix)
}

type HostnameRoutingState = {
  catchAllCount: number
  prefixes: Set<string>
  bindAddress?: string
}

function getOrCreateHostnameState(
  byHostname: Map<string, HostnameRoutingState>,
  hostname: string,
): HostnameRoutingState {
  let state = byHostname.get(hostname)
  if (!state) {
    state = { catchAllCount: 0, prefixes: new Set() }
    byHostname.set(hostname, state)
  }
  return state
}

function recordHostnamePathPrefix(
  state: HostnameRoutingState,
  hostname: string,
  pathPrefix: string | undefined,
): string | null {
  const normalized = normalizeDeployPathPrefix(pathPrefix)
  if (normalized === undefined) {
    state.catchAllCount += 1
    return null
  }
  if (!validateDeployPathPrefix(normalized)) {
    return 'pathPrefix must start with /'
  }
  if (pathPrefixHasUnsupportedCharacters(normalized)) {
    return `pathPrefix contains unsupported characters for hostname ${hostname}`
  }
  if (state.prefixes.has(normalized)) {
    return `duplicate pathPrefix ${normalized} for hostname ${hostname}`
  }
  state.prefixes.add(normalized)
  return null
}

function recordHostnameBindAddress(
  state: HostnameRoutingState,
  hostname: string,
  bindAddress: string | undefined,
): string | null {
  if (!bindAddress) return null
  if (state.bindAddress && state.bindAddress !== bindAddress) {
    return `conflicting bindAddress for hostname ${hostname}`
  }
  state.bindAddress = bindAddress
  return null
}

function findDuplicateCatchAllHostname(
  byHostname: Map<string, HostnameRoutingState>,
): string | null {
  for (const [hostname, state] of byHostname) {
    if (state.catchAllCount > 1) {
      return `multiple catch-all hostings for hostname ${hostname}`
    }
  }
  return null
}

/**
 * HTTP hostings that share a hostname must have unique path prefixes and at most
 * one catch-all route; bind addresses must agree when set.
 */
export function validateDeployHostnameRouting(
  hostings: EnvironmentDeployHosting[],
): string | null {
  const byHostname = new Map<string, HostnameRoutingState>()

  for (const hosting of hostings) {
    if ((hosting.protocol ?? 'http') !== 'http') continue
    for (const hostname of hosting.hostnames) {
      const state = getOrCreateHostnameState(byHostname, hostname)
      const pathError = recordHostnamePathPrefix(
        state,
        hostname,
        hosting.pathPrefix,
      )
      if (pathError) return pathError
      const bindError = recordHostnameBindAddress(
        state,
        hostname,
        hosting.bindAddress,
      )
      if (bindError) return bindError
    }
  }

  return findDuplicateCatchAllHostname(byHostname)
}

export function validateDeployTargetPort(targetPort: number | undefined): boolean {
  if (targetPort === undefined) return true
  return Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535
}

function validateDeployHostingPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function validateDeployHostingEntry(
  hosting: EnvironmentDeployHosting,
): string | null {
  const protocol = hosting.protocol ?? 'http'

  if (protocol === 'http') {
    for (const hostname of hosting.hostnames) {
      if (!isValidHostname(hostname)) {
        return `invalid hostname: ${hostname}`
      }
    }
    if (!validateDeployPathPrefix(hosting.pathPrefix)) {
      return 'pathPrefix must start with /'
    }
    if (!validateDeployTargetPort(hosting.targetPort)) {
      return 'targetPort must be an integer between 1 and 65535'
    }
    return null
  }

  if (!hosting.ports || hosting.ports.length === 0) {
    return `hostings[].ports must not be empty for ${protocol} protocol`
  }
  for (const port of hosting.ports) {
    if (!validateDeployHostingPort(port.published) || !validateDeployHostingPort(port.target)) {
      return 'hostings[].ports entries must be integers between 1 and 65535'
    }
  }
  return null
}

export function validateDeployHostings(
  hostings: EnvironmentDeployHosting[],
): string | null {
  for (const hosting of hostings) {
    const error = validateDeployHostingEntry(hosting)
    if (error) return error
  }
  return validateDeployHostnameRouting(hostings)
}

export function validateDeployStorageMaterial(
  entry: EnvironmentDeployStorageMaterial,
): string | null {
  if (!STORAGE_KINDS.has(entry.kind)) {
    return `invalid storage kind: ${entry.kind}`
  }
  if (entry.kind !== 'docker_volume' && !entry.destinationPath) {
    return `storage ${entry.storageId} missing destinationPath`
  }
  if (
    entry.kind !== 'docker_volume' &&
    !entry.composeServiceName
  ) {
    return `storage ${entry.storageId} missing composeServiceName for mount`
  }
  if (
    typeof entry.volumeName === 'string' &&
    !DOCKER_RESOURCE_NAME_RE.test(entry.volumeName)
  ) {
    return `storage ${entry.storageId} has invalid volumeName`
  }
  return null
}

export function validateDeployStorageMaterialList(
  entries: EnvironmentDeployStorageMaterial[],
): string | null {
  for (const entry of entries) {
    const error = validateDeployStorageMaterial(entry)
    if (error) return error
  }
  return null
}
