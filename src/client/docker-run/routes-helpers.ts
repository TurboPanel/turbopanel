/** Compose `services.<name>` keys, from the vendored Compose Specification. */
const COMPOSE_SERVICE_KEY_RE = /^[a-zA-Z0-9._-]+$/
const SERVICE_NAME_MAX_LENGTH = 63

/**
 * Input caps.
 *
 * The lexer is linear and allocation-light, but it runs on text a signed-in
 * user pastes, and "paste a megabyte" should be a 400 rather than a request
 * that walks the whole thing. Both limits are far above any real
 * `docker run` — the longest in Docker's own documentation is under 1 KB.
 */
const MAX_COMMAND_LENGTH = 16_384
const MAX_ARGV_TOKENS = 512

export type DockerRunImportRequest = {
  serviceName: string
  argv: string | string[]
  projectId: string | null
}

function parseArgvField(rawArgv: unknown): string | string[] | null {
  if (typeof rawArgv === 'string') {
    return rawArgv.length > MAX_COMMAND_LENGTH ? null : rawArgv
  }
  if (!Array.isArray(rawArgv)) return null
  if (rawArgv.length > MAX_ARGV_TOKENS) return null
  if (!rawArgv.every((token) => typeof token === 'string')) return null
  const tokens = rawArgv as string[]
  if (tokens.join(' ').length > MAX_COMMAND_LENGTH) return null
  return tokens
}

/**
 * Validate the wire body.
 *
 * Returns `null` for anything malformed; the caller answers **400**
 * `Invalid request`, matching every other client route rather than inventing a
 * field-by-field error shape this one endpoint would be alone in speaking.
 */
export function parseDockerRunImportRequest(
  body: Record<string, unknown>,
): DockerRunImportRequest | null {
  const serviceName = body.serviceName
  if (typeof serviceName !== 'string' || !serviceName) return null
  if (
    serviceName.length > SERVICE_NAME_MAX_LENGTH ||
    !COMPOSE_SERVICE_KEY_RE.test(serviceName)
  ) {
    return null
  }

  const argv = parseArgvField(body.argv)
  if (argv === null) return null

  const projectId = body.projectId
  if (
    projectId !== undefined && projectId !== null && typeof projectId !== 'string'
  ) {
    return null
  }

  return {
    serviceName,
    argv,
    projectId: typeof projectId === 'string' && projectId ? projectId : null,
  }
}
