export const DRIZZLE_STUDIO_PORT = Number(
  typeof Deno !== 'undefined'
    ? (Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_PORT') ?? '4983')
    : '4983',
)
export const DRIZZLE_STUDIO_HOST =
  typeof Deno !== 'undefined'
    ? (Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_HOST')?.trim() || 'localhost')
    : 'localhost'
export const DRIZZLE_STUDIO_BROWSER_ORIGIN = 'https://local.drizzle.studio'

export function drizzleStudioBrowserUrl(
  port = DRIZZLE_STUDIO_PORT,
  host = DRIZZLE_STUDIO_HOST,
): string {
  const params = new URLSearchParams({ host, port: String(port) })
  return `${DRIZZLE_STUDIO_BROWSER_ORIGIN}?${params.toString()}`
}

/** Probe the local drizzle-kit studio HTTP API (Workers-safe). */
export async function probeDrizzleStudioPort(
  host = '127.0.0.1',
  port = DRIZZLE_STUDIO_PORT,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, {
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
}> {
  const bindHost = DRIZZLE_STUDIO_HOST === 'localhost' ? '127.0.0.1' : DRIZZLE_STUDIO_HOST
  const running = await probeDrizzleStudioPort(bindHost, DRIZZLE_STUDIO_PORT)
  return {
    running,
    port: DRIZZLE_STUDIO_PORT,
    browserUrl: drizzleStudioBrowserUrl(),
  }
}
