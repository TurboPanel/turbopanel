/**
 * Hard safety gates. Nothing here is configurable from the command line: the
 * target allowlist, the refused environments and the refused hosts are
 * constants so a typo or a pasted URL can never aim the runner at live.
 */
import type { Json, Safety } from './types.ts'

/** The only panels the runner will talk to. Exact hostname match, https only. */
export const ALLOWED_TARGET_HOSTS: readonly string[] = [
  'testing.turbopanel.dev',
  'canary.turbopanel.dev',
]

/** `/api/health` `environment` values the runner accepts. Anything else is refused. */
export const ALLOWED_ENVIRONMENTS: readonly string[] = ['testing', 'canary']

/** Named explicitly so the refusal message is clear; any unknown value is refused too. */
export const REFUSED_ENVIRONMENTS: readonly string[] = ['live', 'staging', 'production']

/** Hosts the runner never touches over SSH or as a placement target. */
export const FORBIDDEN_HOSTS: readonly string[] = ['studio.lan', 'studio']

/**
 * Hosts that carry the shared managed Postgres. Managed clusters are never
 * placed there and host-affecting checks never target them.
 */
export const SHARED_DATABASE_HOSTS: readonly string[] = ['adrastea', 'kore']

/** Where host-affecting managed-database checks may create their clusters. */
export const MANAGED_PLACEMENT_HOSTS: readonly string[] = ['themisto', 'megaclite']

export class SafetyError extends Error {
  override name = 'SafetyError'
}

/** Parse and validate a target base URL; returns the normalized origin. */
export function assertTargetUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SafetyError(`target is not a URL: ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'https:') throw new SafetyError(`target must be https: ${url.origin}`)
  if (url.username || url.password) throw new SafetyError('target URL must not carry credentials')
  if (url.port) throw new SafetyError(`target must use the default port: ${url.host}`)
  if (!ALLOWED_TARGET_HOSTS.includes(url.hostname)) {
    throw new SafetyError(
      `target ${url.hostname} is not allowlisted (allowed: ${ALLOWED_TARGET_HOSTS.join(', ')})`
    )
  }
  return url.origin
}

/**
 * The one host whose panel may report no environment: canary is a self-hosted
 * (Deno) install, and those report `environment: null`.
 */
export const NULL_ENVIRONMENT_HOST = 'canary.turbopanel.dev'

/** Refuse unless `/api/health` names an allowlisted environment. Fails closed. */
export function assertHealthEnvironment(status: number, body: Json, hostname = ''): string {
  if (status !== 200) throw new SafetyError(`/api/health returned HTTP ${status}; refusing`)
  const env = isRecord(body) ? body.environment : undefined
  if (env === null && hostname === NULL_ENVIRONMENT_HOST) return 'canary (environment null)'
  if (typeof env !== 'string') {
    throw new SafetyError('/api/health did not report an environment; refusing')
  }
  if (REFUSED_ENVIRONMENTS.includes(env)) {
    throw new SafetyError(`/api/health says environment "${env}"; the runner never runs there`)
  }
  if (!ALLOWED_ENVIRONMENTS.includes(env)) {
    throw new SafetyError(`/api/health environment "${env}" is not allowlisted; refusing`)
  }
  return env
}

/** First DNS label, lowercased: `themisto.privatehosting.xyz` -> `themisto`. */
export function shortHost(host: string): string {
  return host.trim().toLowerCase().split('.')[0] ?? ''
}

/** Refuse SSH to studio and to anything the operator did not name explicitly. */
export function assertSshHost(host: string, allowed: readonly string[]): void {
  const short = shortHost(host)
  if (FORBIDDEN_HOSTS.includes(host.toLowerCase()) || FORBIDDEN_HOSTS.includes(short)) {
    throw new SafetyError(`ssh to ${host} is never allowed`)
  }
  if (!allowed.includes(host)) {
    throw new SafetyError(`ssh to ${host} refused: not passed with --ssh-host`)
  }
}

/** Refuse a managed-cluster placement anywhere but the allowlisted hosts. */
export function assertManagedPlacement(serverName: string): void {
  const short = shortHost(serverName)
  if (SHARED_DATABASE_HOSTS.includes(short)) {
    throw new SafetyError(`${serverName} carries the shared managed Postgres; refusing placement`)
  }
  if (!MANAGED_PLACEMENT_HOSTS.includes(short)) {
    throw new SafetyError(
      `managed placement on ${serverName} refused (allowed: ${MANAGED_PLACEMENT_HOSTS.join(', ')})`
    )
  }
}

/** Refuse a host-affecting target that is forbidden or not passed with `--host`. */
export function assertAffectedHost(serverName: string, hosts: readonly string[]): void {
  const short = shortHost(serverName)
  if (FORBIDDEN_HOSTS.includes(short)) throw new SafetyError(`${serverName} is never touched`)
  if (SHARED_DATABASE_HOSTS.includes(short)) {
    throw new SafetyError(`${serverName} carries the shared managed Postgres; refusing`)
  }
  if (!hosts.map(shortHost).includes(short)) {
    throw new SafetyError(`${serverName} was not passed with --host; refusing`)
  }
}

export const SAFETY_ORDER: readonly Safety[] = ['readonly', 'creates-objects', 'host-affecting']

export interface SafetyFlags {
  apply: boolean
  allowHostAffecting: boolean
  /** Upper bound chosen with `--safety`; defaults to `creates-objects`. */
  maxSafety: Safety
}

/** Whether a check of class `safety` may run under these flags. */
export function safetyPermits(safety: Safety, flags: SafetyFlags): boolean {
  if (!flags.apply) return false
  if (safety === 'host-affecting' && !flags.allowHostAffecting) return false
  return SAFETY_ORDER.indexOf(safety) <= SAFETY_ORDER.indexOf(flags.maxSafety)
}

const SECRET_KEY = /pass(word|wd)?|secret|token|cookie|private.?key|^key$|credential|authorization/i
const PEM_PRIVATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const INLINE_SECRET = /((?:password|passwd|secret|token|cookie)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi

/** Deep copy with every secret-looking field replaced. */
export function redactJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(redactJson)
  if (!isRecord(value)) return typeof value === 'string' ? redactText(value) : value
  const out: { [key: string]: Json } = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && inner !== null ? '<redacted>' : redactJson(inner)
  }
  return out
}

/** Strip PEM private keys and `password=...`-style fragments from free text. */
export function redactText(text: string): string {
  return text.replace(PEM_PRIVATE, '<redacted private key>').replace(INLINE_SECRET, '$1<redacted>')
}

export function isRecord(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
