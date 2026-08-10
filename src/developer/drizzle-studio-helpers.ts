import { join } from '@std/path'
import {
  drizzleStudioBrowserUrl,
  DRIZZLE_STUDIO_PORT,
} from '../drizzle-studio-probe.ts'

export function drizzleKitBinPath(instanceRepoRoot: string): string {
  return join(instanceRepoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs')
}

export function studioStatusWhenBindFails(error: string): {
  running: boolean
  port: number
  browserUrl: string
  error: string
} {
  return {
    running: false,
    port: DRIZZLE_STUDIO_PORT,
    browserUrl: drizzleStudioBrowserUrl(DRIZZLE_STUDIO_PORT, 'localhost'),
    error,
  }
}

export function studioStartWhenDatabaseMissing(): { ok: false; error: string } {
  return {
    ok: false,
    error: 'postgres is not configured (missing TURBOPANEL_DATABASE_URL)',
  }
}

export function studioStartWhenNotReady(detail: string | undefined): { ok: false; error: string } {
  return {
    ok: false,
    error: detail ?? 'drizzle studio did not become ready in time',
  }
}

export async function childErrorDetail(
  child: Deno.ChildProcess | null,
): Promise<string | undefined> {
  if (!child) return undefined
  const status = await Promise.race([
    child.status,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ])
  if (!status || status.success) return undefined
  return `drizzle studio exited (code ${status.code})`
}

export async function waitForStudioPort(
  probe: (host: string) => Promise<boolean>,
  host: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(host)) {
      return true
    }
    await new Promise((resolve) => setTimeout(() => resolve(null), 200))
  }
  return false
}
