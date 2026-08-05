/** Loopback hosts allowed for Drizzle Studio bind / browser query. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export const DRIZZLE_STUDIO_PORT = Number(
  typeof Deno !== 'undefined'
    ? (Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_PORT') ?? '4983')
    : '4983',
)

export const DRIZZLE_STUDIO_BROWSER_ORIGIN = 'https://local.drizzle.studio'

export type ResolveDrizzleStudioHostResult =
  | { ok: true; configuredHost: string; bindHost: string; browserHost: string }
  | { ok: false; error: string }

/**
 * Read `TURBOPANEL_DRIZZLE_STUDIO_HOST` (default `localhost`).
 * Prefer {@link resolveDrizzleStudioBindHost} — raw values may be non-loopback.
 */
export function configuredDrizzleStudioHost(): string {
  if (typeof Deno === 'undefined') return 'localhost'
  return Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_HOST')?.trim() || 'localhost'
}

function normalizeHostToken(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Restrict Studio to loopback only (`localhost`, `127.0.0.1`, `::1`).
 * `localhost` binds as `127.0.0.1` (drizzle-kit); browser URL keeps `localhost`.
 */
export function resolveDrizzleStudioBindHost(
  configuredHost: string = configuredDrizzleStudioHost(),
): ResolveDrizzleStudioHostResult {
  const raw = configuredHost.trim() || 'localhost'
  const host = normalizeHostToken(raw).toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      error:
        `TURBOPANEL_DRIZZLE_STUDIO_HOST must be a loopback host (localhost, 127.0.0.1, or ::1); got ${raw}`,
    }
  }

  let bindHost: string
  if (host === 'localhost' || host === '127.0.0.1') {
    bindHost = '127.0.0.1'
  } else {
    bindHost = '::1'
  }

  const browserHost = host === '127.0.0.1' || host === 'localhost'
    ? 'localhost'
    : '::1'

  return {
    ok: true,
    configuredHost: raw,
    bindHost,
    browserHost,
  }
}

/** Bracket IPv6 for HTTP URLs (`::1` → `[::1]`). */
export function formatDrizzleStudioHttpHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export function drizzleStudioBrowserUrl(
  port = DRIZZLE_STUDIO_PORT,
  host?: string,
): string {
  const resolved = resolveDrizzleStudioBindHost(
    host ?? configuredDrizzleStudioHost(),
  )
  const browserHost = resolved.ok ? resolved.browserHost : 'localhost'
  const params = new URLSearchParams({
    host: browserHost,
    port: String(port),
  })
  return `${DRIZZLE_STUDIO_BROWSER_ORIGIN}?${params.toString()}`
}

/** Prefer loopback `localhost` in the hosted Studio URL when bind host is invalid. */
function safeBrowserUrl(port = DRIZZLE_STUDIO_PORT): string {
  const params = new URLSearchParams({ host: 'localhost', port: String(port) })
  return `${DRIZZLE_STUDIO_BROWSER_ORIGIN}?${params.toString()}`
}

/** Probe the local drizzle-kit studio HTTP API (Workers-safe). */
export async function probeDrizzleStudioPort(
  host = '127.0.0.1',
  port = DRIZZLE_STUDIO_PORT,
): Promise<boolean> {
  try {
    const httpHost = formatDrizzleStudioHttpHost(host)
    const res = await fetch(`http://${httpHost}:${port}/`, {
      signal: AbortSignal.timeout(800),
    })
    return res.status < 500
  } catch {
    return false
  }
}

export async function drizzleStudioProbeStatus(): Promise<{
  running: boolean
  port: number
  browserUrl: string
  error?: string
}> {
  const resolved = resolveDrizzleStudioBindHost()
  if (!resolved.ok) {
    return {
      running: false,
      port: DRIZZLE_STUDIO_PORT,
      browserUrl: safeBrowserUrl(),
      error: resolved.error,
    }
  }
  const running = await probeDrizzleStudioPort(
    resolved.bindHost,
    DRIZZLE_STUDIO_PORT,
  )
  return {
    running,
    port: DRIZZLE_STUDIO_PORT,
    browserUrl: drizzleStudioBrowserUrl(
      DRIZZLE_STUDIO_PORT,
      resolved.configuredHost,
    ),
  }
}
