import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import {
  defaultSystemGitRunner,
  describeUnknownError,
  getUiRepoPath,
  isRuntimePorcelainLine,
  porcelainPath,
  registerSystemRoutes,
  resolveGitInvocation,
  setSystemRoutesTestHooks,
  type SystemGitRunner,
} from './system-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('porcelainPath reads the path and rename target', () => {
  assertEquals(porcelainPath(' M src/app/app.ts'), 'src/app/app.ts')
  assertEquals(porcelainPath('R  old.ts -> new.ts'), 'new.ts')
})

test('isRuntimePorcelainLine ignores checkout-local runtime trees', () => {
  assertEquals(isRuntimePorcelainLine('?? .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? .config/pnpm/store'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/deno'), true)
  assertEquals(isRuntimePorcelainLine(' M src/developer/routes.ts'), false)
})

test('registerSystemRoutes mounts upgrade-status without auth when disabled', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    assertEquals(response.status, 200)
  })
})

test('porcelainPath trims a rename target with extra spaces', () => {
  assertEquals(porcelainPath('R  old.ts ->  new.ts  '), 'new.ts')
})

test('isRuntimePorcelainLine matches a rename into a runtime tree', () => {
  assertEquals(isRuntimePorcelainLine('R  tmp.log -> .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? src/.local-not-runtime.ts'), false)
})

test('registerSystemRoutes requires developer auth by default', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets })
  const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
  assertEquals(response.status, 401)
})

test('POST /system/upgrade is retired: it reset checkouts, so it is no longer mounted', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    const calls: string[][] = []
    setSystemRoutesTestHooks({
      gitRunner: (_bin, args) => {
        calls.push(args)
        return Promise.resolve({ success: true, stdout: '', stderr: '' })
      },
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
      method: 'POST',
    })
    assertEquals(response.status, 404)
    assertEquals(calls, [])
  })
})

test('GET /system/upgrade-status reports canUpgrade or a git error', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({ gitRunner: scriptedGitRunner({}) })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    const body = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body)) {
      throw new TypeError('upgrade-status response must be an object with ok')
    }
    assertEquals(response.status, 200)
    assertEquals(body.ok, true)
    if (!('canUpgrade' in body) || !('dirty' in body)) {
      throw new TypeError('successful upgrade-status must include canUpgrade and dirty')
    }
    assertEquals(typeof body.canUpgrade, 'boolean')
    assertEquals(Array.isArray(body.dirty), true)
  })
})

test('GET /system/upgrade-status fails when TURBOPANEL_UI_REPO is not a checkout', async () => {
  await withSystemRouteEnv(
    {
      TURBOPANEL_DEV_USER: 'dev',
      TURBOPANEL_UI_REPO: '/tmp/turbopanel-missing-ui-checkout',
    },
    async () => {
      setSystemRoutesTestHooks({ gitRunner: null })
      const secrets = await deriveSecretsConfig(
        parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
        'session-signing'
      )
      const app = new Hono()
      registerSystemRoutes(app, { secrets, authRequired: false })
      const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
      assertEquals(response.status, 500)
      const body = await response.json()
      if (typeof body !== 'object' || body === null || !('ok' in body) || !('error' in body)) {
        throw new TypeError('failed upgrade-status must include ok and error')
      }
      assertEquals(body.ok, false)
      assertEquals(typeof body.error, 'string')
    }
  )
})

test('porcelainPath keeps a path that is not a rename', () => {
  assertEquals(porcelainPath('?? path with spaces.ts'), 'path with spaces.ts')
  assertEquals(porcelainPath('D  gone.ts'), 'gone.ts')
})

test('isRuntimePorcelainLine matches every runtime prefix', () => {
  assertEquals(isRuntimePorcelainLine('?? .config/foo'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/bar'), true)
  assertEquals(isRuntimePorcelainLine(' M .local/nested/x'), true)
})

test('resolveGitInvocation runs git directly or via sudo -u', () => {
  assertEquals(
    resolveGitInvocation('/repo', ['status', '--porcelain'], {
      direct: true,
      productionGitUser: 'tp',
    }),
    { bin: 'git', args: ['-C', '/repo', 'status', '--porcelain'] }
  )
  assertEquals(
    resolveGitInvocation('/repo', ['fetch', 'origin', 'trunk'], {
      direct: false,
      productionGitUser: 'tp',
    }),
    {
      bin: 'sudo',
      args: ['-u', 'tp', 'git', '-C', '/repo', 'fetch', 'origin', 'trunk'],
    }
  )
})

test('describeUnknownError reads Error.message and stringifies other values', () => {
  assertEquals(describeUnknownError(new Error('boom')), 'boom')
  assertEquals(describeUnknownError('nope'), 'nope')
})

test('getUiRepoPath prefers TURBOPANEL_UI_REPO and otherwise sits beside the instance checkout', () => {
  const previous = Deno.env.get('TURBOPANEL_UI_REPO')
  try {
    Deno.env.set('TURBOPANEL_UI_REPO', '/tmp/custom-ui')
    assertEquals(getUiRepoPath(), '/tmp/custom-ui')
    Deno.env.delete('TURBOPANEL_UI_REPO')
    const fallback = getUiRepoPath()
    assertEquals(fallback.endsWith('/ui'), true)
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_UI_REPO')
    else Deno.env.set('TURBOPANEL_UI_REPO', previous)
  }
})

function gitVerb(args: string[]): string {
  const dashC = args.indexOf('-C')
  if (dashC >= 0) return args[dashC + 2] ?? ''
  return args[0] ?? ''
}

function scriptedGitRunner(opts: {
  statusStdout?: string
  statusSuccess?: boolean
  statusStderr?: string
}): SystemGitRunner {
  return (_bin, args) => {
    if (gitVerb(args) === 'status') {
      return Promise.resolve({
        success: opts.statusSuccess ?? true,
        stdout: opts.statusStdout ?? '',
        stderr: opts.statusStderr ?? '',
      })
    }
    return Promise.resolve({ success: true, stdout: '', stderr: '' })
  }
}

async function withSystemRouteEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previous.set(key, Deno.env.get(key))
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    return await fn()
  } finally {
    setSystemRoutesTestHooks({ gitRunner: null })
    for (const [key, value] of previous.entries()) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

test('GET /system/upgrade-status reports dirty checkouts and git status failures', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  await withSystemRouteEnv({ TURBOPANEL_DEV_USER: 'dev' }, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ statusStdout: ' M src/app/app.ts\n' }),
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const dirty = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    assertEquals(dirty.status, 200)
    const dirtyBody = (await dirty.json()) as {
      ok: boolean
      canUpgrade: boolean
      dirty: Array<{ repo: string; changes: number }>
    }
    assertEquals(dirtyBody.ok, true)
    assertEquals(dirtyBody.canUpgrade, false)
    assertEquals(dirtyBody.dirty.length > 0, true)
    assertEquals(dirtyBody.dirty[0]?.changes, 1)
  })

  await withSystemRouteEnv({}, async () => {
    setSystemRoutesTestHooks({
      gitRunner: scriptedGitRunner({ statusSuccess: false, statusStderr: '' }),
    })
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const failed = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
    assertEquals(failed.status, 500)
    const body = (await failed.json()) as { ok: boolean; error: string }
    assertEquals(body.ok, false)
    assertEquals(body.error.includes('git status failed'), true)
  })
})

async function initTempGitCheckout(prefix: string): Promise<string> {
  const path = await Deno.makeTempDir({ prefix })
  const init = await new Deno.Command('git', {
    args: ['-C', path, 'init', '-q', '-b', 'trunk'],
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdout: 'null',
    stderr: 'piped',
  }).output()
  if (!init.success) {
    await Deno.remove(path, { recursive: true })
    const stderr = new TextDecoder().decode(init.stderr).trim()
    throw new Error(`git init failed: ${stderr}`)
  }
  return path
}

test('GET /system/upgrade-status uses the default git runner', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  // Host-free: CI has this checkout but not sibling ui/daemon trees.
  const created: string[] = []
  try {
    const daemonRepo = await initTempGitCheckout('tp-daemon-git-')
    created.push(daemonRepo)
    const uiRepo = await initTempGitCheckout('tp-ui-git-')
    created.push(uiRepo)
    await withSystemRouteEnv(
      {
        TURBOPANEL_DEV_USER: 'dev',
        TURBOPANEL_DAEMON_REPO: daemonRepo,
        TURBOPANEL_UI_REPO: uiRepo,
      },
      async () => {
        setSystemRoutesTestHooks({ gitRunner: null })
        const app = new Hono()
        registerSystemRoutes(app, { secrets, authRequired: false })
        const status = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade-status`)
        assertEquals(status.status, 200)
        const body = (await status.json()) as {
          ok: boolean
          canUpgrade: boolean
          dirty: unknown[]
        }
        assertEquals(body.ok, true)
        assertEquals(typeof body.canUpgrade, 'boolean')
        assertEquals(Array.isArray(body.dirty), true)
      }
    )
  } finally {
    for (const repo of created) await Deno.remove(repo, { recursive: true })
  }
})

test('defaultSystemGitRunner maps a missing binary to success:false', async () => {
  const missing = `/tmp/turbopanel-missing-git-${crypto.randomUUID()}`
  const result = await defaultSystemGitRunner(missing, ['status', '--porcelain'])
  assertEquals(result.success, false)
  assertEquals(result.stdout, '')
  assertEquals(result.stderr.length > 0, true)
})
