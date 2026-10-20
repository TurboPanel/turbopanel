/**
 * Which build-time variables may ride a source release's `build.env`, and how
 * many. The host applies its own filter to every build lane; this one keeps the
 * control plane from sending what the host would only throw away, and caps the
 * size of what it does send.
 *
 * Keep the reserved list in step with `RESERVED_BUILD_ENV_KEYS` in the host's
 * `src/deploy/release/build.ts` (the names that are the sandbox, plus the whole
 * `LD_*` namespace) and the name rule with its `isSpecEnvName`.
 */

const RESERVED_BUILD_ENV_KEYS = new Set([
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'HOME',
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'PROMPT_COMMAND',
  'IFS',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'LOCPATH',
  'NLSPATH',
  'HOSTALIASES',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
])

/** A name a shell can carry. */
const BUILD_ENV_NAME_RE = /^[A-Za-z_]\w*$/

/**
 * No command payload limit is enforced elsewhere, so these keep one deploy's
 * build environment small; a normal set (a few `NEXT_PUBLIC_*` values) is far
 * under all three.
 */
export const MAX_BUILD_ENV_ENTRIES = 128
export const MAX_BUILD_ENV_NAME_LENGTH = 255
export const MAX_BUILD_ENV_VALUE_BYTES = 8 * 1024
export const MAX_BUILD_ENV_TOTAL_BYTES = 64 * 1024

/** True when `name` may be set in a build: shell-safe, not the sandbox, not `LD_*`. */
export function isBuildEnvNameAllowed(name: string): boolean {
  return (
    name.length <= MAX_BUILD_ENV_NAME_LENGTH &&
    BUILD_ENV_NAME_RE.test(name) &&
    !RESERVED_BUILD_ENV_KEYS.has(name) &&
    !name.startsWith('LD_')
  )
}

const encoder = new TextEncoder()

/**
 * A plain sentence when a build environment is over a limit, else `null`.
 * `env` is already filtered by {@link isBuildEnvNameAllowed}.
 */
export function buildEnvLimitError(
  composeServiceName: string,
  env: Readonly<Record<string, string>>
): string | null {
  const entries = Object.entries(env)
  if (entries.length > MAX_BUILD_ENV_ENTRIES) {
    return `${composeServiceName} has ${entries.length} build variables; at most ${MAX_BUILD_ENV_ENTRIES} can be sent to a build`
  }
  let total = 0
  for (const [name, value] of entries) {
    const bytes = encoder.encode(value).length
    if (bytes > MAX_BUILD_ENV_VALUE_BYTES) {
      return `The build variable ${name} of ${composeServiceName} is ${bytes} bytes; a build variable can be at most ${MAX_BUILD_ENV_VALUE_BYTES} bytes`
    }
    total += name.length + bytes
  }
  if (total > MAX_BUILD_ENV_TOTAL_BYTES) {
    return `The build variables of ${composeServiceName} add up to ${total} bytes; at most ${MAX_BUILD_ENV_TOTAL_BYTES} bytes can be sent to a build`
  }
  return null
}
