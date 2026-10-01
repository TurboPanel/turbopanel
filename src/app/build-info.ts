/**
 * Deployed revision identity for AGPL Corresponding Source.
 *
 * Workers and Deno both import this module — do not use Deno-only APIs.
 * CI / systemd may set `TURBOPANEL_REVISION` to the exact git commit.
 * `BUILD_INFO.commit` is stamped at compile/deploy time when present: the
 * release workflow before `deno compile`, and `scripts/stamp-build-commit.mjs`
 * (wrangler.jsonc `build.command`) inside Cloudflare Workers Builds, so a
 * plain `wrangler deploy` there still names its commit.
 */

import { resolveInstanceUpdateChannel, type UpdateChannel } from '../contracts/update-channel.ts'
import { INSTANCE_VERSION } from './version.ts'

export type InstanceRevision = Readonly<{
  commit: string
  sourceUrl: string
}>

const SOURCE_REPO = 'https://github.com/TurboPanel/turbopanel'
const LICENSE = 'AGPL-3.0-only'

export const INSTANCE_LICENSE = LICENSE

export const BUILD_INFO: InstanceRevision = {
  commit: '',
  sourceUrl: SOURCE_REPO,
}

export function sourceUrlForCommit(commit: string): string {
  const sha = commit.trim()
  if (!sha || sha === 'unknown' || sha === 'dev') return SOURCE_REPO
  return `${SOURCE_REPO}/tree/${sha}`
}

export function resolveInstanceRevision(
  env: Readonly<Record<string, string | undefined>> | undefined,
  stamped: InstanceRevision = BUILD_INFO
): InstanceRevision {
  const fromEnv = env?.TURBOPANEL_REVISION?.trim()
  const commit = fromEnv || stamped.commit.trim()
  if (!commit) {
    return { commit: 'unknown', sourceUrl: SOURCE_REPO }
  }
  return { commit, sourceUrl: sourceUrlForCommit(commit) }
}

/** A pre-release label is a semver string: `0.1.1-canary.<buildId>`, `0.1.1-rc.1`. */
const BUILD_LABEL_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const BUILD_LABEL_MAX_LENGTH = 128

/**
 * The installed package's full version label when the installer supplied one
 * (`TURBOPANEL_BUILD_LABEL`, e.g. `0.1.1-canary.20260926-192741-3754712` or
 * `0.1.1-rc.1`), else null. The binary never carries it: promotion reuses the
 * canary bytes for rc and release, so only the install knows which label it
 * installed. A value that is not a semver string is ignored.
 */
export function resolveBuildLabel(
  env: Readonly<Record<string, string | undefined>> | undefined
): string | null {
  const raw = env?.TURBOPANEL_BUILD_LABEL?.trim()
  if (!raw || raw.length > BUILD_LABEL_MAX_LENGTH) return null
  return BUILD_LABEL_PATTERN.test(raw) ? raw : null
}

/** The hosted deployments `TURBOPANEL_ENVIRONMENT` may name (wrangler.jsonc per env). */
export const DEPLOYMENT_ENVIRONMENTS = ['testing', 'staging', 'live'] as const

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number]

/**
 * Which hosted deployment this is, from `TURBOPANEL_ENVIRONMENT` (set per env
 * in wrangler.jsonc: `testing`, `live`, later `staging`). Null when unset —
 * local `wrangler dev`, self-hosted Deno — or not one of the known names.
 */
export function resolveDeploymentEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined
): DeploymentEnvironment | null {
  const raw = env?.TURBOPANEL_ENVIRONMENT?.trim().toLowerCase() ?? ''
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as DeploymentEnvironment)
    : null
}

export type HealthPayload = {
  ok: true
  license: string
  /** The instance's semver — what the app holds against its supported range. */
  version: string
  revision: InstanceRevision
  /** The update channel this instance follows (`TURBOPANEL_UPDATE_CHANNEL`, default `release`). */
  channel: UpdateChannel
  /** The installed package's pre-release label, when known; see {@link resolveBuildLabel}. */
  build: string | null
  /** The hosted deployment (`testing` / `staging` / `live`), else null; see {@link resolveDeploymentEnvironment}. */
  environment: DeploymentEnvironment | null
}

export function healthPayload(
  env: Readonly<Record<string, string | undefined>> | undefined
): HealthPayload {
  return {
    ok: true,
    license: INSTANCE_LICENSE,
    version: INSTANCE_VERSION,
    revision: resolveInstanceRevision(env),
    channel: resolveInstanceUpdateChannel(env),
    build: resolveBuildLabel(env),
    environment: resolveDeploymentEnvironment(env),
  }
}
