import { dirname, fromFileUrl, join } from '@std/path'
import { getDatabaseUrl } from './db-url.ts'
import { resolveNodePath } from './node-path.ts'

const STUDIO_API_PORT = Number(Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_PORT') ?? '4983')
const STUDIO_HOST = Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_HOST')?.trim() || 'localhost'
/** Hosted Drizzle Studio UI — connects to the local drizzle-kit API (HTTP on STUDIO_API_PORT). */
export const DRIZZLE_STUDIO_BROWSER_URL = 'https://local.drizzle.studio'

export function drizzleStudioBrowserUrl(): string {
  const params = new URLSearchParams({
    host: STUDIO_HOST,
    port: String(STUDIO_API_PORT),
  })
  return `${DRIZZLE_STUDIO_BROWSER_URL}?${params.toString()}`
}

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

let studioChild: Deno.ChildProcess | null = null
let studioRunning = false

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
    port: STUDIO_API_PORT,
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

  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) {
    return {
      ok: false,
      error: 'postgres is not configured (missing TURBOPANEL_DATABASE_URL)',
    }
  }

  const nodeBin = await resolveNodePath()
  const studioEnv: Record<string, string> = {
    ...Deno.env.toObject(),
    DATABASE_URL: databaseUrl,
    TURBOPANEL_DATABASE_URL: databaseUrl,
  }

  const bindHost = STUDIO_HOST === 'localhost' ? '127.0.0.1' : STUDIO_HOST

  try {
    const command = new Deno.Command(nodeBin, {
      args: [
        drizzleKitPath(),
        'studio',
        '--host',
        bindHost,
        '--port',
        String(STUDIO_API_PORT),
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

    const ready = await waitForStudioPort(bindHost, 30_000)
    if (!ready) {
      const detail = await childErrorDetail(studioChild)
      stopDrizzleStudio()
      return {
        ok: false,
        error: detail ?? 'drizzle studio did not become ready in time',
      }
    }

    return { ok: true, browserUrl: drizzleStudioBrowserUrl(), port: STUDIO_API_PORT }
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

async function waitForStudioPort(host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port: STUDIO_API_PORT })
      conn.close()
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return false
}
