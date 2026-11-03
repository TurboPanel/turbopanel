import type { Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { getDaemonRepoPath } from '../daemon/version.ts'
import type { Db } from '../db/connection.ts'
import { dirname, fromFileUrl, join } from '@std/path'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..', '..')
})()

export function getUiRepoPath(): string {
  const override = Deno.env.get('TURBOPANEL_UI_REPO')?.trim()
  if (override) return override
  return join(INSTANCE_REPO_ROOT, '..', 'ui')
}

/** Platform checkouts whose local changes `GET /system/upgrade-status` reports. */
const PLATFORM_REPOS = [
  { name: 'instance', path: INSTANCE_REPO_ROOT },
  { name: 'daemon', path: getDaemonRepoPath },
  { name: 'ui', path: getUiRepoPath },
] as const

export type DirtyRepo = {
  repo: string
  path: string
  changes: number
}

export type UpgradeStatus = {
  ok: true
  canUpgrade: boolean
  dirty: DirtyRepo[]
}

export type SystemGitResult = {
  success: boolean
  stdout: string
  stderr: string
}

export type SystemGitRunner = (bin: string, args: string[]) => Promise<SystemGitResult>

export function resolveGitInvocation(
  repoRoot: string,
  args: string[],
  opts: Readonly<{ direct: boolean; productionGitUser: string }>
): { bin: string; args: string[] } {
  const gitArgs = ['-C', repoRoot, ...args]
  if (opts.direct) {
    return { bin: 'git', args: gitArgs }
  }
  return {
    bin: 'sudo',
    args: ['-u', opts.productionGitUser, 'git', ...gitArgs],
  }
}

export function describeUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function usesDirectGit(): boolean {
  return (Deno.env.get('TURBOPANEL_DEV_USER')?.trim() ?? '').length > 0
}

function productionGitUser(): string {
  return Deno.env.get('TURBOPANEL_USER')?.trim() || 'tp'
}

export async function defaultSystemGitRunner(
  bin: string,
  args: string[]
): Promise<SystemGitResult> {
  try {
    const command = new Deno.Command(bin, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await command.output()
    const decoder = new TextDecoder()
    return {
      success: out.success,
      stdout: decoder.decode(out.stdout).trim(),
      stderr: decoder.decode(out.stderr).trim(),
    }
  } catch (err) {
    return { success: false, stdout: '', stderr: describeUnknownError(err) }
  }
}

let systemGitRunner: SystemGitRunner = defaultSystemGitRunner

export function setSystemRoutesTestHooks(
  hooks: {
    gitRunner?: SystemGitRunner | null
  } = {}
): void {
  if (hooks.gitRunner !== undefined) {
    systemGitRunner = hooks.gitRunner ?? defaultSystemGitRunner
  }
}

/** Run git as the dev user directly, or via sudo -u on managed production hosts. */
async function git(repoRoot: string, args: string[]): Promise<SystemGitResult> {
  const invocation = resolveGitInvocation(repoRoot, args, {
    direct: usesDirectGit(),
    productionGitUser: productionGitUser(),
  })
  return await systemGitRunner(invocation.bin, invocation.args)
}

const RUNTIME_DIR_PREFIXES = ['.config/', '.local/', '.cache/'] as const

export function porcelainPath(line: string): string {
  const raw = line.slice(3).trim()
  const arrow = raw.indexOf(' -> ')
  return (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim()
}

export function isRuntimePorcelainLine(line: string): boolean {
  const path = porcelainPath(line)
  return RUNTIME_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))
}

async function repoDirty(
  repoRoot: string
): Promise<{ ok: true; dirty: boolean; changes: number } | { ok: false; error: string }> {
  const status = await git(repoRoot, ['status', '--porcelain'])
  if (!status.success) {
    return {
      ok: false,
      error: status.stderr || 'git status failed',
    }
  }
  const lines = status.stdout
    ? status.stdout
        .split('\n')
        .filter(Boolean)
        .filter((line) => !isRuntimePorcelainLine(line))
    : []
  return { ok: true, dirty: lines.length > 0, changes: lines.length }
}

async function collectDirtyRepos(): Promise<
  { ok: true; dirty: DirtyRepo[] } | { ok: false; error: string }
> {
  const dirty: DirtyRepo[] = []
  for (const repo of PLATFORM_REPOS) {
    const path = typeof repo.path === 'function' ? repo.path() : repo.path
    const result = await repoDirty(path)
    if (!result.ok) {
      return { ok: false, error: `${repo.name}: ${result.error}` }
    }
    if (result.dirty) {
      dirty.push({ repo: repo.name, path, changes: result.changes })
    }
  }
  return { ok: true, dirty }
}

export function registerSystemRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean }
): Hono<E> {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/system/*`, createDeveloperAccessMiddleware(opts.secrets))
  }

  app.get(`${DEVELOPER_API_PREFIX}/system/upgrade-status`, async (c) => {
    const result = await collectDirtyRepos()
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500)
    }
    const body: UpgradeStatus = {
      ok: true,
      canUpgrade: result.dirty.length === 0,
      dirty: result.dirty,
    }
    return c.json(body)
  })

  return app
}
