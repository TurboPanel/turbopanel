import { isValidHostname } from './hostname.ts'
import type { CommandType } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export type PingCommandPayload = Record<string, never>

export type RebootCommandPayload = Record<string, never>

export type HostnameSetCommandPayload = {
  hostname: string
}

export function parsePingPayload(value: unknown): PingCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid ping payload')
  }
  return {}
}

export function parseRebootPayload(value: unknown): RebootCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid reboot payload')
  }
  return {}
}

export function parseHostnameSetPayload(value: unknown): HostnameSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set payload')
  }
  const hostname = value.hostname
  if (!isString(hostname) || hostname.length === 0 || !isValidHostname(hostname)) {
    throw new Error('Invalid hostname set payload')
  }
  return { hostname }
}

export type PingCommandResult = {
  apiAcceptedAt?: string
  queuedAt?: string
  consumerReceivedAt?: string
  cellEnqueuedAt?: string
  /** Instance-side WS send time from the cell outbox pump (`markSent`). */
  cellDispatchedAt?: string
  daemonReceivedAt?: string
  daemonRespondedAt?: string
  resultRecordedAt?: string
  daemonHostname?: string
  daemonBuild?: {
    commit?: string
    buildId?: string
    builtAt?: string
    channel?: string
  }
}

export type HostnameSetCommandResult = {
  observedHostname: string
  summary?: string
}

export type RebootCommandResult = {
  scheduled: boolean
  summary?: string
}

export function parsePingResult(value: unknown): PingCommandResult {
  if (!isRecord(value)) {
    return {}
  }
  const result: PingCommandResult = {}
  if (isString(value.apiAcceptedAt)) result.apiAcceptedAt = value.apiAcceptedAt
  if (isString(value.queuedAt)) result.queuedAt = value.queuedAt
  if (isString(value.consumerReceivedAt)) result.consumerReceivedAt = value.consumerReceivedAt
  if (isString(value.cellEnqueuedAt)) result.cellEnqueuedAt = value.cellEnqueuedAt
  if (isString(value.cellDispatchedAt)) {
    result.cellDispatchedAt = value.cellDispatchedAt
  }
  if (isString(value.daemonReceivedAt)) result.daemonReceivedAt = value.daemonReceivedAt
  if (isString(value.daemonRespondedAt)) result.daemonRespondedAt = value.daemonRespondedAt
  if (isString(value.resultRecordedAt)) result.resultRecordedAt = value.resultRecordedAt
  if (isString(value.daemonHostname)) result.daemonHostname = value.daemonHostname
  if (isRecord(value.daemonBuild)) {
    const build: NonNullable<PingCommandResult['daemonBuild']> = {}
    if (isString(value.daemonBuild.commit)) build.commit = value.daemonBuild.commit
    if (isString(value.daemonBuild.buildId)) build.buildId = value.daemonBuild.buildId
    if (isString(value.daemonBuild.builtAt)) build.builtAt = value.daemonBuild.builtAt
    if (isString(value.daemonBuild.channel)) build.channel = value.daemonBuild.channel
    if (Object.keys(build).length > 0) {
      result.daemonBuild = build
    }
  }
  return result
}

export function parseHostnameSetResult(value: unknown): HostnameSetCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set result')
  }
  const observedHostname = value.observedHostname
  if (!isString(observedHostname) || observedHostname.length === 0) {
    throw new Error('Invalid hostname set result')
  }
  const result: HostnameSetCommandResult = { observedHostname }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

export function parseRebootResult(value: unknown): RebootCommandResult {
  if (!isRecord(value)) {
    return { scheduled: false }
  }
  const result: RebootCommandResult = {
    scheduled: value.scheduled === true,
  }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

export type EnvironmentDeployCommandPayload = {
  environmentId: string
  projectId: string
  projectName: string
  /** Runtime docker-compose YAML (presentation stripped). */
  composeYaml: string
  /** Public hosting routes to wire through Traefik + edge Caddy. */
  hostings: EnvironmentDeployHosting[]
}

export type EnvironmentDeployHosting = {
  hostingId: string
  serviceId: string
  composeServiceName: string
  hostnames: string[]
  pathPrefix?: string
  /** Container port Traefik should target (default 80). */
  targetPort?: number
}

export type EnvironmentDeployCommandResult = {
  projectName: string
  summary?: string
  services?: string[]
}

export function parseEnvironmentDeployPayload(value: unknown): EnvironmentDeployCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const environmentId = value.environmentId
  const projectId = value.projectId
  const projectName = value.projectName
  const composeYaml = value.composeYaml
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(projectName) ||
    !isString(composeYaml) ||
    composeYaml.length === 0
  ) {
    throw new Error('Invalid environment.deploy payload')
  }
  const hostingsRaw = value.hostings
  if (!Array.isArray(hostingsRaw)) {
    throw new Error('Invalid environment.deploy payload')
  }
  const hostings: EnvironmentDeployHosting[] = []
  for (const entry of hostingsRaw) {
    if (!isRecord(entry)) throw new Error('Invalid environment.deploy payload')
    if (
      !isString(entry.hostingId) ||
      !isString(entry.serviceId) ||
      !isString(entry.composeServiceName)
    ) {
      throw new Error('Invalid environment.deploy payload')
    }
    if (!Array.isArray(entry.hostnames) || !entry.hostnames.every(isString)) {
      throw new Error('Invalid environment.deploy payload')
    }
    const hosting: EnvironmentDeployHosting = {
      hostingId: entry.hostingId,
      serviceId: entry.serviceId,
      composeServiceName: entry.composeServiceName,
      hostnames: entry.hostnames as string[],
    }
    if (isString(entry.pathPrefix)) hosting.pathPrefix = entry.pathPrefix
    if (typeof entry.targetPort === 'number' && Number.isFinite(entry.targetPort)) {
      hosting.targetPort = entry.targetPort
    }
    hostings.push(hosting)
  }
  return { environmentId, projectId, projectName, composeYaml, hostings }
}

export function parseEnvironmentDeployResult(value: unknown): EnvironmentDeployCommandResult {
  if (!isRecord(value)) {
    return { projectName: '' }
  }
  const result: EnvironmentDeployCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : '',
  }
  if (isString(value.summary)) result.summary = value.summary
  if (Array.isArray(value.services) && value.services.every(isString)) {
    result.services = value.services as string[]
  }
  return result
}

export function parseCommandPayload(
  type: CommandType,
  value: unknown,
):
  | PingCommandPayload
  | HostnameSetCommandPayload
  | RebootCommandPayload
  | EnvironmentDeployCommandPayload {
  switch (type) {
    case 'daemon.ping':
      return parsePingPayload(value)
    case 'server.hostname.set':
      return parseHostnameSetPayload(value)
    case 'server.reboot':
      return parseRebootPayload(value)
    case 'environment.deploy':
      return parseEnvironmentDeployPayload(value)
  }
}

export function parseCommandResult(
  type: CommandType,
  value: unknown,
):
  | PingCommandResult
  | HostnameSetCommandResult
  | RebootCommandResult
  | EnvironmentDeployCommandResult {
  switch (type) {
    case 'daemon.ping':
      return parsePingResult(value)
    case 'server.hostname.set':
      return parseHostnameSetResult(value)
    case 'server.reboot':
      return parseRebootResult(value)
    case 'environment.deploy':
      return parseEnvironmentDeployResult(value)
  }
}
