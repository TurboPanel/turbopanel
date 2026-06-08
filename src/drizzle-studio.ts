import { dirname, fromFileUrl, join } from '@std/path'
import { buildPostgresUrlFromEnv, postgresEnvFromEnv } from './db-url.ts'

const STUDIO_PORT = Number(Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_PORT') ?? '4983')
const STUDIO_HOST = Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_HOST')?.trim() || '127.0.0.1'
/** Hosted Drizzle Studio UI — connects to the API server on STUDIO_PORT (localhost when forwarded). */
export const DRIZZLE_STUDIO_BROWSER_URL = 'https://local.drizzle.studio'

export function drizzleStudioBrowserUrl(port = STUDIO_PORT): string {
  return port === 4983 ? DRIZZLE_STUDIO_BROWSER_URL : `${DRIZZLE_STUDIO_BROWSER_URL}?port=${port}`
}

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

let studioChild: Deno.ChildProcess | null = null
let studioRunning = false

function nodeBinDir(): string {
  const fromPath = Deno.env.get('PATH')?.split(':').find((entry) =>
    entry.endsWith('/node/current/bin') || entry.endsWith('/node/current')
  )
  if (fromPath) return fromPath.endsWith('/bin') ? fromPath : join(fromPath, 'bin')
  return '/opt/turbopanel/runtimes/node/current/bin'
}

function nodePath(): string {
  return join(nodeBinDir(), 'node')
}

function drizzleKitPath(): string {
  return join(INSTANCE_REPO_ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs')
}

export function drizzleStudioStatus(): {
  running: boolean
  port: number
  browserUrl: string
} {
  return {
    running: studioRunning,
    port: STUDIO_PORT,
    browserUrl: drizzleStudioBrowserUrl(),
  }
}

export async function startDrizzleStudio(): Promise<
  { ok: true; browserUrl: string; port: number } | { ok: false; error: string }
> {
  const status = drizzleStudioStatus()
  if (status.running) {
    return { ok: true, browserUrl: status.browserUrl, port: status.port }
  }

  const pg = postgresEnvFromEnv()
  if (!pg) {
    return { ok: false, error: 'postgres is not configured (missing TURBOPANEL_PG_* env)' }
  }

  const databaseUrl = buildPostgresUrlFromEnv()
  const nodeBin = nodeBinDir()
  const path = [nodeBin, Deno.env.get('PATH') ?? ''].filter(Boolean).join(':')
  const studioEnv: Record<string, string> = { ...Deno.env.toObject(), PATH: path }
  // Socket mode: drizzle.config.ts reads TURBOPANEL_PG_* object credentials.
  if (databaseUrl) studioEnv.DATABASE_URL = databaseUrl
  else delete studioEnv.DATABASE_URL

  try {
    const command = new Deno.Command(nodePath(), {
      args: [
        drizzleKitPath(),
        'studio',
        '--host',
        STUDIO_HOST,
        '--port',
        String(STUDIO_PORT),
      ],
      cwd: INSTANCE_REPO_ROOT,
      env: studioEnv,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    })
    studioChild = command.spawn()
    studioRunning = true

    studioChild.status.then(() => {
      studioRunning = false
      studioChild = null
    }).catch(() => {
      studioRunning = false
      studioChild = null
    })

    const ready = await waitForStudioPort(30_000)
    if (!ready) {
      const detail = await childErrorDetail(studioChild)
      stopDrizzleStudio()
      return {
        ok: false,
        error: detail ?? 'drizzle studio did not become ready in time',
      }
    }

    return { ok: true, browserUrl: drizzleStudioBrowserUrl(), port: STUDIO_PORT }
  } catch (err) {
    studioRunning = false
    studioChild = null
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export function stopDrizzleStudio(): void {
  if (!studioChild) {
    studioRunning = false
    return
  }
  try {
    studioChild.kill('SIGTERM')
  } catch {
    // already gone
  }
  studioRunning = false
  studioChild = null
}

async function childErrorDetail(
  child: Deno.ChildProcess | null,
): Promise<string | undefined> {
  if (!child) return undefined
  const status = await Promise.race([
    child.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ])
  if (!status || status.success) return undefined
  const stderr = child.stderr
  if (!stderr) return `drizzle studio exited (code ${status.code})`
  const text = new TextDecoder().decode(await stderr.getReader().read().then((r) => r.value ?? new Uint8Array()))
  const line = text.split('\n').map((s) => s.trim()).find(Boolean)
  return line ?? `drizzle studio exited (code ${status.code})`
}

async function waitForStudioPort(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: STUDIO_HOST, port: STUDIO_PORT })
      conn.close()
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return false
}
