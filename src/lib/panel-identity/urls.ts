/**
 * The panel's public origins in the admin's order (URL 0 is the chosen install
 * URL). Stored names are `host` or `host:port`; each becomes `https://...`.
 */
export function orderedPublicOrigins(rows: ReadonlyArray<{ host: string }>): string[] {
  const seen = new Set<string>()
  const origins: string[] = []
  for (const row of rows) {
    const host = row.host.trim().replace(/\.$/, '')
    if (host === '') continue
    const origin = /^https?:\/\//.test(host) ? host : `https://${host}`
    if (!seen.has(origin)) {
      seen.add(origin)
      origins.push(origin)
    }
  }
  return origins
}
