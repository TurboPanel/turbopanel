import { join } from '@std/path'
import { getDaemonRepoPath } from '../daemon/version.ts'
import { isDeveloperSurfaceEnabled } from '../dev-mode.ts'

const REQUIRED_RELEASE_ARTIFACTS = [
  'turbopaneld-linux-amd64.tar.zst',
  'turbopaneld-linux-arm64.tar.zst',
] as const

const REQUIRED_COMPILE_ARTIFACTS = [
  '.build/turbopaneld-linux-amd64',
  '.build/turbopaneld-linux-arm64',
] as const

function resolveDenoBin(): string {
  const override = Deno.env.get('TURBOPANEL_DENO')?.trim()
  if (override) return override
  const runtimeDeno = '/opt/turbopanel/runtimes/deno/current/deno'
  try {
    Deno.statSync(runtimeDeno)
    return runtimeDeno
  } catch {
    return '/usr/local/bin/deno'
  }
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path)
    return stat.isFile && stat.size > 0
  } catch {
    return false
  }
}

async function allDevReleaseArtifactsPresent(distDir: string): Promise<boolean> {
  for (const name of REQUIRED_RELEASE_ARTIFACTS) {
    if (!(await artifactExists(join(distDir, name)))) return false
  }
  return true
}

async function allCompileArtifactsPresent(distDir: string): Promise<boolean> {
  for (const name of REQUIRED_COMPILE_ARTIFACTS) {
    if (!(await artifactExists(join(distDir, name)))) return false
  }
  return true
}

/**
 * Run a daemon deno task as the instance process user (turbopaneli). The checkout
 * is group-writable via the turbopanel supplementary group — no sudo to turbopanel.
 */
async function runDaemonTask(
  daemonRepo: string,
  denoBin: string,
  task: string,
): Promise<void> {
  const command = new Deno.Command(denoBin, {
    args: ['task', task],
    cwd: daemonRepo,
    stdout: 'piped',
    stderr: 'piped',
    env: {
      HOME: Deno.env.get('HOME') ?? '',
      PATH: Deno.env.get('PATH') ?? '/usr/local/bin:/usr/bin:/bin',
      DENO_DIR: Deno.env.get('DENO_DIR') ?? '',
    },
  })
  const out = await command.output()
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim()
    const stdout = new TextDecoder().decode(out.stdout).trim()
    const detail = stderr || stdout || `${task} failed`
    throw new Error(`daemon release step failed (${task}): ${detail}`)
  }
}

/**
 * Ensure zstd-compressed cross-arch daemon release tarballs exist before showing
 * a dev install command. Skips when the developer surface is disabled or
 * artifacts are already packaged.
 */
export async function ensureDevDaemonBinaries(): Promise<void> {
  if (!isDeveloperSurfaceEnabled()) return

  const daemonRepo = getDaemonRepoPath()
  const distDir = join(daemonRepo, 'dist')
  if (await allDevReleaseArtifactsPresent(distDir)) return

  const denoBin = resolveDenoBin()

  if (await allCompileArtifactsPresent(distDir)) {
    await runDaemonTask(daemonRepo, denoBin, 'package:release')
  } else {
    await runDaemonTask(daemonRepo, denoBin, 'release:package')
  }

  if (!(await allDevReleaseArtifactsPresent(distDir))) {
    throw new Error(
      'daemon release packaging finished but expected dist/*.tar.zst artifacts are still missing',
    )
  }
}
