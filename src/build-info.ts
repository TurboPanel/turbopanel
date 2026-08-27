/**
 * Deployed revision identity for AGPL Corresponding Source.
 *
 * Workers and Deno both import this module — do not use Deno-only APIs.
 * CI / systemd may set `TURBOPANEL_REVISION` to the exact git commit.
 * `BUILD_INFO.commit` is stamped at compile/deploy time when present.
 */

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
  stamped: InstanceRevision = BUILD_INFO,
): InstanceRevision {
  const fromEnv = env?.TURBOPANEL_REVISION?.trim()
  const commit = fromEnv || stamped.commit.trim()
  if (!commit) {
    return { commit: 'unknown', sourceUrl: SOURCE_REPO }
  }
  return { commit, sourceUrl: sourceUrlForCommit(commit) }
}

export function healthPayload(
  env: Readonly<Record<string, string | undefined>> | undefined,
): { ok: true; license: string; revision: InstanceRevision } {
  return {
    ok: true,
    license: INSTANCE_LICENSE,
    revision: resolveInstanceRevision(env),
  }
}
