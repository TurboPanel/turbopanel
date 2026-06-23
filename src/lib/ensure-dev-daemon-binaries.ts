import { join } from '@std/path'
import { getDaemonRepoPath } from '../daemon/version.ts'
import { isDeveloperSurfaceEnabled } from '../dev-mode.ts'

const REQUIRED_BINARIES = [
  'turbopanel-daemon-linux-amd64',
  'turbopanel-daemon-linux-arm64',
] as const

function resolveDenoBin(): string {
  const override = Deno.env.get('TURBOPANEL_DENO')?.trim()
  if (override) return override
  return '/opt/turbopanel/runtimes/deno/current/deno'
}

function resolveDaemonUser(): string {
  return Deno.env.get('TURBOPANEL_USER')?.trim() || 'turbopanel'
}

async function binaryExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path)
    return stat.isFile && stat.size > 0
  } catch {
    return false
  }
}

async function allDevBinariesPresent(distDir: string): Promise<boolean> {
  for (const name of REQUIRED_BINARIES) {
    if (!(await binaryExists(join(distDir, name)))) return false
  }
  return true
}

/**
 * Ensure cross-arch daemon binaries exist before showing a dev install command.
 * Skips when the developer surface is disabled or binaries are already built.
 */
export async function ensureDevDaemonBinaries(): Promise<void> {
  if (!isDeveloperSurfaceEnabled()) return

  const daemonRepo = getDaemonRepoPath()
  const distDir = join(daemonRepo, 'dist')
  if (await allDevBinariesPresent(distDir)) return

  const denoBin = resolveDenoBin()
  const daemonUser = resolveDaemonUser()
  const shellCommand = `cd '${daemonRepo}' && exec '${denoBin}' task compile:all`

  const command = new Deno.Command('sudo', {
    args: ['-u', daemonUser, '/bin/sh', '-c', shellCommand],
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await command.output()
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim()
    const stdout = new TextDecoder().decode(out.stdout).trim()
    const detail = stderr || stdout || 'compile:all failed'
    throw new Error(`daemon binary compile failed: ${detail}`)
  }

  if (!(await allDevBinariesPresent(distDir))) {
    throw new Error(
      'daemon binary compile finished but expected dist artifacts are still missing',
    )
  }
}
