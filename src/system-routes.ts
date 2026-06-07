import { Hono } from 'hono'
import { broadcastToDaemons, type DaemonMessage } from './daemon-hub.ts'
import {
  getDaemonCommit,
  getDaemonRepoPath,
  getInstanceCommit,
} from './daemon-version.ts'
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk'
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim()

let upgrading = false

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const command = new Deno.Command('git', {
      args: ['-C', repoRoot, ...args],
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

async function syncRepoToTrunk(
  repoRoot: string,
  label: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
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

  return { ok: true }
}

export function registerSystemRoutes(app: Hono): Hono {
  app.post('/api/system/upgrade', async (c) => {
    if (upgrading) {
      return c.json({ ok: false, error: 'upgrade already in progress' }, 409)
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
      const daemonVersion = await getDaemonCommit(true)
      const message: DaemonMessage = {
        type: 'version',
        commit: daemonVersion.commit,
        branch: daemonVersion.branch,
        at: new Date().toISOString(),
      }
      broadcastToDaemons(message)

      const restart = await new Deno.Command('systemctl', {
        args: ['restart', INSTANCE_SERVICE],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      if (!restart.success) {
        const err = new TextDecoder().decode(restart.stderr).trim()
        return c.json(
          {
            ok: false,
            error: `repos updated but systemctl restart ${INSTANCE_SERVICE} failed: ${
              err || 'unknown error'
            }`,
          },
          500,
        )
      }

      return c.json({ ok: true, commit: instanceVersion.commit })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: message }, 500)
    } finally {
      upgrading = false
    }
  })

  return app
}
