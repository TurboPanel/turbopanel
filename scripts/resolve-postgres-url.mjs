/** Parse self-hosted postgres URLs, including Unix-socket `?host=` form. */
export function resolvePostgresParts(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return undefined
    }
    const user = decodeURIComponent(parsed.username)
    const database = parsed.pathname.replace(/^\//, '')
    if (!user || !database) return undefined
    const socketDir = parsed.searchParams.get('host')?.trim() || null
    if (socketDir) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir,
        tcpUrl: null,
      }
    }
    if (parsed.hostname) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir: null,
        tcpUrl: url,
      }
    }
    return undefined
  } catch {
    // `postgresql://user:pass@/db?host=/path` has no hostname — URL rejects it.
    const match = url.match(/^postgres(?:ql)?:\/\/([^:@]+)(?::([^@]*))?@\/([^?]+)(?:\?(.*))?$/)
    if (!match) return undefined

    const [, userEnc, passwordEnc = '', dbEnc, query = ''] = match
    const socketDir = new URLSearchParams(query).get('host')?.trim() || null
    if (!socketDir) return undefined

    const user = decodeURIComponent(userEnc)
    const database = decodeURIComponent(dbEnc)
    if (!user || !database) return undefined

    return {
      user,
      pass: decodeURIComponent(passwordEnc),
      database,
      socketDir,
      tcpUrl: null,
    }
  }
}

/** drizzle-kit dbCredentials from a postgres connection URL. */
export function drizzleDbCredentials(url) {
  const parts = resolvePostgresParts(url)
  if (!parts) {
    throw new Error('invalid TURBOPANEL_DATABASE_URL')
  }
  if (parts.socketDir) {
    return {
      host: parts.socketDir,
      user: parts.user,
      password: parts.pass,
      database: parts.database,
    }
  }
  return { url: parts.tcpUrl ?? url }
}

/** Read TURBOPANEL_DATABASE_URL and return drizzle-kit dbCredentials. */
export function drizzleDbCredentialsFromEnv() {
  const url = process.env.TURBOPANEL_DATABASE_URL?.trim()
  if (!url) {
    throw new Error('TURBOPANEL_DATABASE_URL is required')
  }
  return drizzleDbCredentials(url)
}
