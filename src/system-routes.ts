import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from './auth/middleware.ts'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { resetDevInstance } from './dev-reset.ts'
import { getDaemonRepoPath, getInstanceCommit } from './daemon-version.ts'
import type { Db } from './db.ts'
import { dirname, fromFileUrl, join } from '@std/path'
import { DEVELOPER_API_PREFIX } from './surfaces.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

function getUiRepoPath(): string {
  const override = Deno.env.get('TURBOPANEL_UI_REPO')?.trim()
  if (override) return override
  return join(INSTANCE_REPO_ROOT, '..', 'ui')
}

/** Platform checkouts Upgrade System may reset — all must be clean first. */
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

const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk'
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim()
const TURBOPANEL_USER = Deno.env.get('TURBOPANEL_USER')?.trim() || 'turbopanel'
const NORMALIZE_CHECKOUT = '/usr/local/bin/turbopanel-normalize-dev-checkout'

let upgrading = false
let resettingDev = false

/** Run git as turbopanel (9999) so the deploy key stays mode 0600 and checkouts stay editable. */
async function git(
  repoRoot: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const command = new Deno.Command('sudo', {
      args: ['-u', TURBOPANEL_USER, 'git', '-C', repoRoot, ...args],
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
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, stdout: '', stderr: message }
  }
}

/** After git reset, re-home any instance-owned source files back to turbopanel (9999). */
async function runCheckoutHelper(
  repoRoot: string,
  mode?: '--prepare-reset' | '--ensure-runtime-dirs',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = mode
    ? [NORMALIZE_CHECKOUT, repoRoot, mode]
    : [NORMALIZE_CHECKOUT, repoRoot]
  try {
    const out = await new Deno.Command('sudo', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (out.success) return { ok: true }
    return {
      ok: false,
      error: new TextDecoder().decode(out.stderr).trim() ||
        (mode ? `${mode} failed` : 'normalize checkout failed'),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

async function normalizeCheckout(
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return await runCheckoutHelper(repoRoot)
}

const RUNTIME_DIR_PREFIXES = ['.config/', '.local/', '.cache/'] as const

function porcelainPath(line: string): string {
  const raw = line.slice(3).trim()
  const arrow = raw.indexOf(' -> ')
  return (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim()
}

function isRuntimePorcelainLine(line: string): boolean {
  const path = porcelainPath(line)
  return RUNTIME_DIR_PREFIXES.some((prefix) => path.startsWith(prefix))
}

async function repoDirty(
  repoRoot: string,
): Promise<{ ok: true; dirty: boolean; changes: number } | { ok: false; error: string }> {
  const status = await git(repoRoot, ['status', '--porcelain'])
  if (!status.success) {
    return {
      ok: false,
      error: status.stderr || 'git status failed',
    }
  }
  const lines = status.stdout
    ? status.stdout.split('\n').filter(Boolean).filter((line) => !isRuntimePorcelainLine(line))
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

function dirtyUpgradeError(dirty: DirtyRepo[]): string {
  const names = dirty.map((entry) => entry.repo).join(', ')
  return `cannot upgrade: uncommitted changes in ${names} (commit or stash first)`
}

async function syncRepoToTrunk(
  repoRoot: string,
  label: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prepared = await runCheckoutHelper(repoRoot, '--prepare-reset')
  if (!prepared.ok) {
    return {
      ok: false,
      error: `${label} checkout prepare failed: ${prepared.error}`,
    }
  }

  const fetched = await git(repoRoot, ['fetch', 'origin', TRUNK_BRANCH])
  if (!fetched.success) {
    return {
      ok: false,
      error: `${label} git fetch failed: ${fetched.stderr}`,
    }
  }

  const reset = await git(repoRoot, ['reset', '--hard', `origin/${TRUNK_BRANCH}`])
  if (!reset.success) {
    return {
      ok: false,
      error: `${label} git reset failed: ${reset.stderr}`,
    }
  }

  const normalized = await normalizeCheckout(repoRoot)
  if (!normalized.ok) {
    return {
      ok: false,
      error: `${label} checkout permission fix failed: ${normalized.error}`,
    }
  }

  const runtime = await runCheckoutHelper(repoRoot, '--ensure-runtime-dirs')
  if (!runtime.ok) {
    return {
      ok: false,
      error: `${label} runtime dir setup failed: ${runtime.error}`,
    }
  }

  return { ok: true }
}

export function registerSystemRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; db?: Db },
): Hono {
  app.use(`${DEVELOPER_API_PREFIX}/system/*`, createRootOnlyMiddleware(opts.secrets))

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

  app.post(`${DEVELOPER_API_PREFIX}/system/upgrade`, async (c) => {
    if (upgrading) {
      return c.json({ ok: false, error: 'upgrade already in progress' }, 409)
    }

    const dirtyCheck = await collectDirtyRepos()
    if (!dirtyCheck.ok) {
      return c.json({ ok: false, error: dirtyCheck.error }, 500)
    }
    if (dirtyCheck.dirty.length > 0) {
      return c.json(
        {
          ok: false,
          error: dirtyUpgradeError(dirtyCheck.dirty),
          dirty: dirtyCheck.dirty,
        },
        409,
      )
    }

    if (!INSTANCE_SERVICE) {
      return c.json(
        {
          ok: false,
          error:
            'instance upgrade restart unavailable: TURBOPANEL_INSTANCE_SERVICE is not set (run under systemd or configure a managed service)',
        },
        503,
      )
    }

    upgrading = true
    try {
      const instanceSync = await syncRepoToTrunk(INSTANCE_REPO_ROOT, 'instance')
      if (!instanceSync.ok) {
        return c.json({ ok: false, error: instanceSync.error }, 500)
      }

      const daemonSync = await syncRepoToTrunk(getDaemonRepoPath(), 'daemon')
      if (!daemonSync.ok) {
        return c.json({ ok: false, error: daemonSync.error }, 500)
      }

      const instanceVersion = await getInstanceCommit()
      const commit = instanceVersion.commit

      // Queue restart without awaiting — awaiting systemctl restart kills this
      // process before the HTTP response reaches Caddy (client sees HTTP 502).
      new Deno.Command('sudo', {
        args: ['systemctl', 'restart', INSTANCE_SERVICE],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn()

      return c.json({ ok: true, commit })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: message }, 500)
    } finally {
      upgrading = false
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/system/reset-dev`, async (c) => {
    if (resettingDev) {
      return c.json({ ok: false, error: 'dev reset already in progress' }, 409)
    }
    if (!opts.db) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    resettingDev = true
    try {
      const result = await resetDevInstance(opts.db)
      if (!result.ok) {
        return c.json({ ok: false, error: result.error }, 500)
      }
      return c.json({ ok: true, restarted: result.restarted })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: message }, 500)
    } finally {
      resettingDev = false
    }
  })

  return app
}
