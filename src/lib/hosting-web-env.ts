/** Hosting-scoped web/PHP metadata merged at deploy for sites. */

import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { decryptSecret } from '../client/authn/data-encryption.ts'
import {
  resolveInheritedVariablesForHosting,
  type ResolvedVariableMap,
} from '../client/variables/resolve-inherited.ts'
import type { Db } from '../db.ts'
import {
  HOSTING_WEB_ENV_KEY_RE,
  parseHostingOptions,
  type HostingWebOptions,
} from './hosting-options.ts'
import type {
  EnvironmentDeployHostingPhp,
  EnvironmentDeployHostingWeb,
  EnvironmentDeploySite,
} from './commands/schemas.ts'

const MAX_WEB_ENV_ENTRIES = 64
const MAX_WEB_ENV_VALUE_LENGTH = 4096

export function sanitizeHostingWebEnv(
  raw: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_WEB_ENV_VALUE_LENGTH) continue
    env[key] = trimmed
    if (Object.keys(env).length >= MAX_WEB_ENV_ENTRIES) break
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function isUsableWebEnvValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_WEB_ENV_VALUE_LENGTH
}

async function mergeRuntimeVariablesIntoEnv(
  env: Record<string, string>,
  varMap: ResolvedVariableMap,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  for (const [key, entry] of varMap) {
    if (!entry.forRuntime || !HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    let value = entry.value
    if (entry.isSecret) {
      value = await decryptSecret(dataEncryptionSecrets, entry.value)
    }
    if (!isUsableWebEnvValue(value)) continue
    env[key] = value.trim()
  }
}

function buildDeployWeb(
  env: Record<string, string>,
  php: EnvironmentDeployHostingPhp | undefined,
): EnvironmentDeployHostingWeb | undefined {
  const hasEnv = Object.keys(env).length > 0
  if (!hasEnv && !php) return undefined
  const out: EnvironmentDeployHostingWeb = {}
  if (hasEnv) out.env = env
  if (php) out.php = php
  return out
}

/**
 * Merge `options.web.env`, hosting-scoped variables (`forRuntime`), and inherited
 * hosting chain. Explicit `options.web.env` wins on key collisions.
 */
export async function resolveHostingDeployWeb(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  hostingId: string,
  options: unknown,
): Promise<EnvironmentDeployHostingWeb | undefined> {
  const parsed = parseHostingOptions(options)
  if (parsed === null) return undefined

  const webOpts: HostingWebOptions | undefined = parsed.web
  const varMap = await resolveInheritedVariablesForHosting(db, hostingId)
  const env: Record<string, string> = {}
  await mergeRuntimeVariablesIntoEnv(env, varMap, dataEncryptionSecrets)

  const staticEnv = sanitizeHostingWebEnv(webOpts?.env)
  if (staticEnv) Object.assign(env, staticEnv)

  return buildDeployWeb(env, undefined)
}

/**
 * Merge hosting `web.env` onto sites.
 *
 * **PHP is no longer merged here.** A php-fpm pool is keyed by
 * `(environmentId, composeServiceName)` — 1:1 with the service — so a
 * per-hosting PHP setting was structurally unrepresentable downstream, and this
 * function used to shallow-merge several hostings last-wins with no warning.
 * PHP now comes from the compose service's `x-turbopanel.php`, which is the
 * entity the pool actually belongs to. `env` stays here because it genuinely is
 * per hostname.
 */
export function attachWebMetadataToSites(
  sites: EnvironmentDeploySite[],
  hostings: readonly { composeServiceName: string; web?: EnvironmentDeployHostingWeb }[],
): EnvironmentDeploySite[] {
  const byService = new Map<string, Record<string, string>>()

  for (const hosting of hostings) {
    if (!hosting.web?.env) continue
    const current = byService.get(hosting.composeServiceName) ?? {}
    Object.assign(current, hosting.web.env)
    byService.set(hosting.composeServiceName, current)
  }

  return sites.map((site) => {
    const env = byService.get(site.composeServiceName)
    if (!env || Object.keys(env).length === 0) return site
    return { ...site, webEnv: env }
  })
}

/** Shell `export`-safe lines for `.turbopanel/hosting.env` (daemon materialization). */
export function formatHostingEnvFile(env: Record<string, string>): string {
  const keys = Object.keys(env).sort((a, b) => a.localeCompare(b))
  const lines: string[] = []
  for (const key of keys) {
    const value = env[key] ?? ''
    const escaped = value
      .replaceAll('\\', String.raw`\\`)
      .replaceAll('"', String.raw`\"`)
      .replaceAll('\n', String.raw`\n`)
    lines.push(`${key}="${escaped}"`)
  }
  return `${lines.join('\n')}\n`
}

export function parseHostingEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replaceAll(String.raw`\n`, '\n')
        .replaceAll(String.raw`\"`, '"')
        .replaceAll(String.raw`\\`, '\\')
    }
    env[key] = value
  }
  return env
}
