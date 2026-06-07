import { Hono } from 'hono'
import { getDaemonRepoPath, getInstanceCommit } from './daemon-version.ts'
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1'
import { DEVELOPER_API_PREFIX } from './surfaces.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk'
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim()
const TURBOPANEL_USER = Deno.env.get('TURBOPANEL_USER')?.trim() || 'turbopanel'
const NORMALIZE_CHECKOUT = '/usr/local/bin/turbopanel-normalize-dev-checkout'

let upgrading = false

// #region agent log
function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  const payload = {
    sessionId: 'bf61d3',
    location,
    message,
    data,
    timestamp: Date.now(),
    hypothesisId,
  }
  console.error(`DEBUG_BF61D3 ${JSON.stringify(payload)}`)
  fetch('http://localhost:7686/ingest/1326dc58-69fc-4780-871a-d504ad5cb2c6', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'bf61d3' },
    body: JSON.stringify(payload),
  }).catch(() => {})
  Deno.writeTextFile(`/run/turbopanel/debug-bf61d3.log`, `${JSON.stringify(payload)}\n`, {
    append: true,
  }).catch(() => {})
}
// #endregion

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
async function normalizeCheckout(
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const out = await new Deno.Command('sudo', {
      args: [NORMALIZE_CHECKOUT, repoRoot],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (out.success) return { ok: true }
    return {
      ok: false,
      error: new TextDecoder().decode(out.stderr).trim() || 'normalize checkout failed',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
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

  const normalized = await normalizeCheckout(repoRoot)
  if (!normalized.ok) {
    return {
      ok: false,
      error: `${label} checkout permission fix failed: ${normalized.error}`,
    }
  }

  return { ok: true }
}

export function registerSystemRoutes(app: Hono): Hono {
  app.post(`${DEVELOPER_API_PREFIX}/system/upgrade`, async (c) => {
    // #region agent log
    agentLog('system-routes.ts:upgrade-entry', 'upgrade handler entered', {
      upgrading,
      instanceService: INSTANCE_SERVICE ?? null,
    }, 'C')
    // #endregion
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
      // #region agent log
      agentLog('system-routes.ts:instance-sync', 'instance repo sync finished', {
        ok: instanceSync.ok,
        error: !instanceSync.ok ? instanceSync.error : null,
      }, 'B')
      // #endregion
      if (!instanceSync.ok) {
        return c.json({ ok: false, error: instanceSync.error }, 500)
      }

      const daemonSync = await syncRepoToTrunk(getDaemonRepoPath(), 'daemon')
      // #region agent log
      agentLog('system-routes.ts:daemon-sync', 'daemon repo sync finished', {
        ok: daemonSync.ok,
        error: !daemonSync.ok ? daemonSync.error : null,
      }, 'B')
      // #endregion
      if (!daemonSync.ok) {
        return c.json({ ok: false, error: daemonSync.error }, 500)
      }

      const instanceVersion = await getInstanceCommit()
      const commit = instanceVersion.commit

      // #region agent log
      agentLog('system-routes.ts:pre-response', 'returning success before detached restart', {
        service: INSTANCE_SERVICE,
        commit,
      }, 'A')
      // #endregion

      // Queue restart without awaiting — awaiting systemctl restart kills this
      // process before the HTTP response reaches Caddy (client sees HTTP 502).
      const restartChild = new Deno.Command('sudo', {
        args: ['systemctl', 'restart', INSTANCE_SERVICE],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn()

      // #region agent log
      agentLog('system-routes.ts:restart-spawned', 'detached restart queued', {
        pid: restartChild.pid,
      }, 'A')
      // #endregion

      return c.json({ ok: true, commit })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // #region agent log
      agentLog('system-routes.ts:catch', 'upgrade handler threw', { message }, 'D')
      // #endregion
      return c.json({ ok: false, error: message }, 500)
    } finally {
      upgrading = false
    }
  })

  return app
}
