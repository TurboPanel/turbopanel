/** Hosting-scoped web/PHP metadata merged at deploy for sites. */

import {
  type ResolvedVariableMap,
  resolveInheritedVariablesForHosting,
} from '../variables/resolve-inherited.ts'
import type { Db } from '../../db/connection.ts'
import {
  HOSTING_WEB_ENV_KEY_RE,
  type HostingWebOptions,
  parseHostingOptions,
} from './hosting-options.ts'
import type {
  EnvironmentDeployHostingPhp,
  EnvironmentDeployHostingWeb,
  EnvironmentDeploySite,
} from '../../contracts/commands/schemas.ts'

const MAX_WEB_ENV_ENTRIES = 64
const MAX_WEB_ENV_VALUE_LENGTH = 4096

export function sanitizeHostingWebEnv(
  raw: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!raw) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_WEB_ENV_VALUE_LENGTH) {
      continue
    }
    env[key] = trimmed
    if (Object.keys(env).length >= MAX_WEB_ENV_ENTRIES) break
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function isUsableWebEnvValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_WEB_ENV_VALUE_LENGTH
}

/**
 * Runtime variables of the hosting chain, split by kind. A secret is **not**
 * decrypted here: its stored envelope is carried as is (still sealed under the
 * control plane's key) so no plaintext exists on this path, and the deploy
 * reseals it for the daemon (`sealHostingWebSecretsForDaemon`).
 */
function mergeRuntimeVariables(
  env: Record<string, string>,
  secretEnv: Record<string, string>,
  varMap: ResolvedVariableMap
): void {
  for (const [key, entry] of varMap) {
    if (!entry.forRuntime || !HOSTING_WEB_ENV_KEY_RE.test(key)) continue
    if (entry.isSecret) {
      secretEnv[key] = entry.value
    } else if (isUsableWebEnvValue(entry.value)) {
      env[key] = entry.value.trim()
    }
  }
}

function buildDeployWeb(
  env: Record<string, string>,
  secretEnv: Record<string, string>,
  php: EnvironmentDeployHostingPhp | undefined
): EnvironmentDeployHostingWeb | undefined {
  const hasEnv = Object.keys(env).length > 0
  const hasSecretEnv = Object.keys(secretEnv).length > 0
  if (!hasEnv && !hasSecretEnv && !php) return undefined
  const out: EnvironmentDeployHostingWeb = {}
  if (hasEnv) out.env = env
  if (hasSecretEnv) out.secretEnv = secretEnv
  if (php) out.php = php
  return out
}

/**
 * Merge `options.web.env`, hosting-scoped variables (`forRuntime`), and inherited
 * hosting chain. Explicit `options.web.env` wins on key collisions. Secret
 * variables come back in `secretEnv` still sealed under the control plane's key
 * (see {@link mergeRuntimeVariables}).
 */
export async function resolveHostingDeployWeb(
  db: Db,
  hostingId: string,
  options: unknown
): Promise<EnvironmentDeployHostingWeb | undefined> {
  const parsed = parseHostingOptions(options)
  if (parsed === null) return undefined

  const webOpts: HostingWebOptions | undefined = parsed.web
  const varMap = await resolveInheritedVariablesForHosting(db, hostingId)
  const env: Record<string, string> = {}
  const secretEnv: Record<string, string> = {}
  mergeRuntimeVariables(env, secretEnv, varMap)

  const staticEnv = sanitizeHostingWebEnv(webOpts?.env)
  if (staticEnv) {
    Object.assign(env, staticEnv)
    // A name is either plain or secret, never both: the static value wins.
    for (const key of Object.keys(staticEnv)) delete secretEnv[key]
  }

  return buildDeployWeb(env, secretEnv, undefined)
}

type ServiceWebEnv = {
  env: Record<string, string>
  secretEnv: Record<string, string>
}

/**
 * Merge hosting `web.env` and `web.secretEnv` onto sites.
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
  hostings: readonly {
    composeServiceName: string
    web?: EnvironmentDeployHostingWeb
  }[]
): EnvironmentDeploySite[] {
  const byService = new Map<string, ServiceWebEnv>()

  for (const hosting of hostings) {
    if (!hosting.web?.env && !hosting.web?.secretEnv) continue
    const current = byService.get(hosting.composeServiceName) ?? { env: {}, secretEnv: {} }
    // A name stays plain or secret, never both: the later hosting's kind wins.
    for (const [key, value] of Object.entries(hosting.web.env ?? {})) {
      delete current.secretEnv[key]
      current.env[key] = value
    }
    for (const [key, value] of Object.entries(hosting.web.secretEnv ?? {})) {
      delete current.env[key]
      current.secretEnv[key] = value
    }
    byService.set(hosting.composeServiceName, current)
  }

  return sites.map((site) => {
    const web = byService.get(site.composeServiceName)
    if (!web) return site
    const hasEnv = Object.keys(web.env).length > 0
    const hasSecretEnv = Object.keys(web.secretEnv).length > 0
    if (!hasEnv && !hasSecretEnv) return site
    return {
      ...site,
      ...(hasEnv ? { webEnv: web.env } : {}),
      ...(hasSecretEnv ? { webSecretEnv: web.secretEnv } : {}),
    }
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
