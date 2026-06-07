import { dirname, fromFileUrl, join } from 'jsr:@std/path@1'
import { buildPostgresUrlFromEnv } from './db-url.ts'

const STUDIO_PORT = Number(Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_PORT') ?? '4983')
const STUDIO_HOST = Deno.env.get('TURBOPANEL_DRIZZLE_STUDIO_HOST')?.trim() || '127.0.0.1'
/** Browser path on the Caddy HTTPS entrypoint (dev only). */
export const DRIZZLE_STUDIO_PUBLIC_PATH = '/drizzle-studio/'

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

function pnpmPath(): string {
  return join(nodeBinDir(), 'pnpm')
}

export function drizzleStudioStatus(): {
  running: boolean
  port: number
  publicPath: string
} {
  return {
    running: studioRunning,
    port: STUDIO_PORT,
    publicPath: DRIZZLE_STUDIO_PUBLIC_PATH,
  }
}

export async function startDrizzleStudio(): Promise<
  { ok: true; publicPath: string } | { ok: false; error: string }
> {
  const status = drizzleStudioStatus()
  if (status.running) {
    return { ok: true, publicPath: status.publicPath }
  }

  const databaseUrl = buildPostgresUrlFromEnv()
  if (!databaseUrl) {
    return { ok: false, error: 'postgres is not configured (missing TURBOPANEL_PG_* env)' }
  }

  const nodeBin = nodeBinDir()
  const path = [nodeBin, Deno.env.get('PATH') ?? ''].filter(Boolean).join(':')

  try {
    const command = new Deno.Command(pnpmPath(), {
      args: [
        'exec',
        'drizzle-kit',
        'studio',
        '--host',
        STUDIO_HOST,
        '--port',
        String(STUDIO_PORT),
      ],
      cwd: INSTANCE_REPO_ROOT,
      env: {
        ...Deno.env.toObject(),
        PATH: path,
        DATABASE_URL: databaseUrl,
      },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    })
    studioChild = command.spawn()
    studioRunning = true

    // Reap the child when it exits so status stays accurate.
    studioChild.status.then(() => {
      studioRunning = false
      studioChild = null
    }).catch(() => {
      studioRunning = false
      studioChild = null
    })

    const ready = await waitForStudioPort(10_000)
    if (!ready) {
      stopDrizzleStudio()
      return { ok: false, error: 'drizzle studio did not become ready in time' }
    }

    return { ok: true, publicPath: DRIZZLE_STUDIO_PUBLIC_PATH }
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
