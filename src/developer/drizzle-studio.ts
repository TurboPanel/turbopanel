import { dirname, fromFileUrl, join } from '@std/path'
import { getDatabaseUrl } from '../db-url.ts'
import {
  DRIZZLE_STUDIO_CONFIG,
  writeDrizzleKitConfig,
} from '../drizzle-kit-config.ts'
import {
  configuredDrizzleStudioHost,
  drizzleStudioBrowserUrl,
  DRIZZLE_STUDIO_PORT,
  probeDrizzleStudioPort,
  resolveDrizzleStudioBindHost,
} from '../drizzle-studio-probe.ts'
import { resolveNodePath } from '../node-path.ts'
import { logInfo, logWarn } from '../logger.ts'
import {
  childErrorDetail,
  drizzleKitBinPath,
  studioStartWhenDatabaseMissing,
  studioStartWhenNotReady,
  studioStatusWhenBindFails,
  waitForStudioPort,
} from './drizzle-studio-helpers.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..', '..')
})()

let studioChild: Deno.ChildProcess | null = null
let studioRunning = false

function resolveStudioBindHost():
  | { ok: true; bindHost: string; configuredHost: string }
  | { ok: false; error: string } {
  return resolveDrizzleStudioBindHost(configuredDrizzleStudioHost())
}

async function isStudioPortListening(host: string): Promise<boolean> {
  return probeDrizzleStudioPort(host, DRIZZLE_STUDIO_PORT)
}

async function isStudioChildAlive(): Promise<boolean> {
  if (!studioChild) return false
  const status = await Promise.race([
    studioChild.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  ])
  return status === null
}

export async function drizzleStudioStatus(): Promise<{
  running: boolean
  port: number
  browserUrl: string
  error?: string
}> {
  const resolved = resolveStudioBindHost()
  if (!resolved.ok) {
    studioRunning = false
    return studioStatusWhenBindFails(resolved.error)
  }

  const portOpen = await isStudioPortListening(resolved.bindHost)
  if (portOpen) {
    studioRunning = true
  } else if (!studioChild) {
    studioRunning = false
  }
  return {
    running: portOpen || studioRunning,
    port: DRIZZLE_STUDIO_PORT,
    browserUrl: drizzleStudioBrowserUrl(
      DRIZZLE_STUDIO_PORT,
      resolved.configuredHost,
    ),
  }
}

/** Start Drizzle Studio when the developer surface is enabled (dev UI mode). */
export async function ensureDrizzleStudioInDev(): Promise<void> {
  const started = await startDrizzleStudio()
  if (started.ok) {
    logInfo('instance', `Drizzle Studio ready at ${started.browserUrl}`)
  } else {
    logWarn('instance', `Drizzle Studio failed to start: ${started.error}`)
  }
}

export async function startDrizzleStudio(): Promise<
  { ok: true; browserUrl: string; port: number } | { ok: false; error: string }
> {
  const resolved = resolveStudioBindHost()
  if (!resolved.ok) {
    return { ok: false, error: resolved.error }
  }
  const bindHost = resolved.bindHost
  const browserUrl = drizzleStudioBrowserUrl(
    DRIZZLE_STUDIO_PORT,
    resolved.configuredHost,
  )

  if (await isStudioPortListening(bindHost)) {
    studioRunning = true
    return { ok: true, browserUrl, port: DRIZZLE_STUDIO_PORT }
  }

  if (studioRunning && await isStudioChildAlive()) {
    return {
      ok: true,
      browserUrl,
      port: DRIZZLE_STUDIO_PORT,
    }
  }

  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) {
    return studioStartWhenDatabaseMissing()
  }

  const nodeBin = await resolveNodePath()

  try {
    await writeDrizzleKitConfig(databaseUrl, DRIZZLE_STUDIO_CONFIG)

    const command = new Deno.Command(nodeBin, {
      args: [
        drizzleKitBinPath(INSTANCE_REPO_ROOT),
        'studio',
        '--config',
        DRIZZLE_STUDIO_CONFIG,
        '--host',
        bindHost,
        '--port',
        String(DRIZZLE_STUDIO_PORT),
      ],
      cwd: INSTANCE_REPO_ROOT,
      env: Deno.env.toObject(),
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
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

    const ready = await waitForStudioPort(isStudioPortListening, bindHost, 30_000)
    const childAlive = await isStudioChildAlive()

    if (!ready || !childAlive) {
      const detail = await childErrorDetail(studioChild)
      stopDrizzleStudio()
      return studioStartWhenNotReady(detail)
    }

    return { ok: true, browserUrl, port: DRIZZLE_STUDIO_PORT }
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
