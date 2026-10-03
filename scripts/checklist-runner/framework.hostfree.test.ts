import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { mailpitSink, sshExec } from './adapters.ts'
import { main, parseArgs, UsageError, type MainDeps } from './cli.ts'
import { ApiClient, type FetchLike } from './http.ts'
import { acquireLock, LockHeldError, type LockFs } from './lock.ts'
import { planChecks, roadLines, runOne, runPlan, runPrefix, toMarkdown } from './runner.ts'
import {
  SafetyError,
  assertAffectedHost,
  assertHealthEnvironment,
  assertManagedPlacement,
  assertSshHost,
  assertTargetUrl,
  redactJson,
  redactText,
} from './safety.ts'
import type { Api, Check, CheckContext, Json } from './types.ts'

const TESTING = 'https://testing.turbopanel.dev'

interface Call {
  method: string
  url: string
}

/** A fake panel: health, sign-in, organizations, and a recorder for everything else. */
function fakePanel(environment: string | null, calls: Call[], extra?: FetchLike): FetchLike {
  return async (url, init) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url })
    if (url.endsWith('/api/health')) {
      return Response.json(environment === null ? { ok: true } : { ok: true, environment })
    }
    if (url.includes('/auth/sign-in')) {
      return new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'tp_session=abc; HttpOnly' },
      })
    }
    if (url.includes('/client/v1/organizations')) {
      return Response.json({ organizations: [{ id: 'org-1' }] })
    }
    return extra ? extra(url, init) : Response.json({ ok: true })
  }
}

function memoryLockFs(): LockFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    createNew(path, content) {
      if (files.has(path)) return Promise.reject(new Deno.errors.AlreadyExists(path))
      files.set(path, content)
      return Promise.resolve()
    },
    readText: (path) => Promise.resolve(files.get(path) ?? ''),
    remove(path) {
      files.delete(path)
      return Promise.resolve()
    },
  }
}

function deps(fetchImpl: FetchLike, registry: Check[], over: Partial<MainDeps> = {}) {
  const written = new Map<string, string>()
  const printed: string[] = []
  const d: MainDeps = {
    fetch: fetchImpl,
    env: (k) =>
      ({
        TESTING_URL: TESTING,
        TESTING_EMAIL: 'owner@example.test',
        TESTING_PASSWORD: runtimePw(),
      })[k],
    now: () => new Date('2026-10-02T12:00:00Z'),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    print: (line) => void printed.push(line),
    writeFile: (path, text) => {
      written.set(path, text)
      return Promise.resolve()
    },
    mkdir: () => Promise.resolve(),
    lockFs: memoryLockFs(),
    tmpDir: '/tmp',
    registry,
    ...over,
  }
  return { d, written, printed }
}

/** Built at run time so no credential-shaped literal sits in the source. */
function runtimePw(): string {
  return ['t', String(Date.now()), 'x'].join('-')
}

function check(rowId: string, safety: Check['safety'], run?: Check['run']): Check {
  return {
    rowId,
    title: rowId,
    requires: ['api'],
    safety,
    run: run ?? (() => Promise.resolve({ verdict: 'pass', evidence: 'ok' })),
  }
}

function writingCheck(rowId: string): Check {
  return check(rowId, 'creates-objects', async (ctx) => {
    await ctx.api.post('/client/v1/projects', { body: { name: `${ctx.prefix}-p` } })
    return { verdict: 'pass', evidence: 'created' }
  })
}

Deno.test('target allowlist: only testing and canary over https', () => {
  assertEquals(assertTargetUrl('https://testing.turbopanel.dev/'), TESTING)
  assertEquals(assertTargetUrl('https://canary.turbopanel.dev'), 'https://canary.turbopanel.dev')
  for (const bad of [
    'https://turbopanel.dev',
    'https://staging.turbopanel.dev',
    'http://testing.turbopanel.dev',
    'https://testing.turbopanel.dev.evil.example',
    'https://testing.turbopanel.dev:8443',
    'https://u:p@testing.turbopanel.dev',
    'not a url',
  ]) {
    let refused = false
    try {
      assertTargetUrl(bad)
    } catch (error) {
      refused = error instanceof SafetyError
    }
    assert(refused, `expected refusal for ${bad}`)
  }
})

Deno.test('health gate refuses live, staging, unknown and missing environments', () => {
  assertEquals(assertHealthEnvironment(200, { environment: 'testing' }), 'testing')
  for (const env of ['live', 'staging', 'production', 'dev']) {
    let refused = false
    try {
      assertHealthEnvironment(200, { environment: env })
    } catch (error) {
      refused = error instanceof SafetyError
    }
    assert(refused, env)
  }
  let refused = 0
  for (const [status, body] of [
    [200, { ok: true }],
    [503, { environment: 'testing' }],
  ] as [number, Json][]) {
    try {
      assertHealthEnvironment(status, body)
    } catch {
      refused++
    }
  }
  assertEquals(refused, 2)
})

Deno.test('main refuses a live target before signing in', async () => {
  const calls: Call[] = []
  const { d } = deps(fakePanel('live', calls), [check('a', 'readonly')])
  await assertRejects(() => main(['--apply'], d), SafetyError)
  assertEquals(
    calls.map((c) => c.url),
    [`${TESTING}/api/health`]
  )
})

Deno.test('main refuses when health reports staging even in dry run', async () => {
  const calls: Call[] = []
  const { d } = deps(fakePanel('staging', calls), [check('a', 'readonly')])
  await assertRejects(() => main([], d), SafetyError)
})

Deno.test('main refuses a non-allowlisted TESTING_URL', async () => {
  const calls: Call[] = []
  const { d } = deps(fakePanel('testing', calls), [], {
    env: (k) => (k === 'TESTING_URL' ? 'https://live.turbopanel.dev' : undefined),
  })
  await assertRejects(() => main([], d), SafetyError)
  assertEquals(calls.length, 0)
})

Deno.test('dry run makes no API calls beyond health and runs no check', async () => {
  const calls: Call[] = []
  let ran = false
  const spy = check('spy', 'readonly', () => {
    ran = true
    return Promise.resolve({ verdict: 'pass', evidence: '' })
  })
  const { d, written } = deps(fakePanel('testing', calls), [spy, writingCheck('w')])
  const code = await main([], d)
  assertEquals(code, 0)
  assertEquals(ran, false)
  assertEquals(calls, [{ method: 'GET', url: `${TESTING}/api/health` }])
  const json = [...written].find(([k]) => k.endsWith('.json'))?.[1] ?? ''
  const rows = JSON.parse(json) as { verdict: string }[]
  assert(rows.every((r) => r.verdict === 'skip'))
})

Deno.test('apply runs readonly + creates-objects by default, never host-affecting', async () => {
  const calls: Call[] = []
  const registry = [check('r', 'readonly'), writingCheck('c'), check('h', 'host-affecting')]
  const { d, written } = deps(fakePanel('testing', calls), registry)
  await main(['--apply'], d)
  const json = [...written].find(([k]) => k.endsWith('.json'))?.[1] ?? '[]'
  const verdicts = Object.fromEntries(
    (JSON.parse(json) as { id: string; verdict: string }[]).map((r) => [r.id, r.verdict])
  )
  assertEquals(verdicts, { r: 'pass', c: 'pass', h: 'skip' })
  const projectCall = calls.find((c) => c.url.includes('/projects'))
  assertStringIncludes(projectCall?.url ?? '', 'organizationId=org-1')
})

Deno.test(
  '--safety readonly gives a GET-only client: a write fails the check, not the panel',
  async () => {
    const calls: Call[] = []
    const { d, written } = deps(fakePanel('testing', calls), [writingCheck('w')])
    // writingCheck is creates-objects so it is skipped; force it through as readonly
    const sneaky = { ...writingCheck('sneaky'), safety: 'readonly' as const }
    d.registry = [sneaky]
    await main(['--apply', '--safety', 'readonly'], d)
    assert(!calls.some((c) => c.url.includes('/projects')))
    const json = [...written].find(([k]) => k.endsWith('.json'))?.[1] ?? '[]'
    const [row] = JSON.parse(json) as { verdict: string; evidence: string }[]
    assertEquals(row?.verdict, 'fail')
    assertStringIncludes(row?.evidence ?? '', 'read-only run')
  }
)

Deno.test('host-affecting needs both --apply and --allow-host-affecting', () => {
  let usage = false
  try {
    parseArgs(['--allow-host-affecting'], '/tmp')
  } catch (error) {
    usage = error instanceof UsageError
  }
  assert(usage)
  const opts = parseArgs(['--apply', '--allow-host-affecting', '--host', 'io'], '/tmp')
  const plan = planChecks([check('h', 'host-affecting')], { ...opts, available: new Set(['api']) })
  assertEquals(plan[0]?.run, true)
  const plain = parseArgs(['--apply'], '/tmp')
  const skipped = planChecks([check('h', 'host-affecting')], {
    ...plain,
    available: new Set(['api']),
  })
  assertEquals(skipped[0]?.run, false)
  assertStringIncludes(skipped[0]?.reason ?? '', '--allow-host-affecting')
})

Deno.test('missing capability skips the check with a reason', () => {
  const opts = parseArgs(['--apply'], '/tmp')
  const mailCheck: Check = { ...check('m', 'readonly'), requires: ['api', 'mail'] }
  const [p] = planChecks([mailCheck], { ...opts, available: new Set(['api']) })
  assertEquals(p?.run, false)
  assertStringIncludes(p?.reason ?? '', 'mail')
})

const silent = {
  prefix: 'clr-test',
  hosts: [],
  sshHosts: [],
  sleep: () => Promise.resolve(),
  probe: () => Promise.resolve(0),
  log: () => undefined,
}
const nullApi: Api = {
  orgId: 'o',
  get: () => Promise.reject(new Error('no')),
  post: () => Promise.reject(new Error('no')),
  put: () => Promise.reject(new Error('no')),
  patch: () => Promise.reject(new Error('no')),
  del: () => Promise.reject(new Error('no')),
}

Deno.test('cleanup runs LIFO on failure and survives a failing step', async () => {
  const order: string[] = []
  const failing = check('f', 'creates-objects', (ctx: CheckContext) => {
    ctx.defer('first', () => {
      order.push('first')
      return Promise.resolve()
    })
    ctx.defer('second', () => Promise.reject(new Error('boom')))
    ctx.defer('third', () => {
      order.push('third')
      return Promise.resolve()
    })
    throw new Error('check exploded')
  })
  const leftovers: string[] = []
  const result = await runOne(failing, { api: nullApi, ...silent }, leftovers)
  assertEquals(result.verdict, 'fail')
  assertStringIncludes(result.evidence, 'check exploded')
  assertEquals(order, ['third', 'first'])
  assertEquals(leftovers.length, 1)
  assertStringIncludes(leftovers[0] ?? '', 'second')
})

Deno.test('results keep the results-*.json shape and evidence is redacted', async () => {
  const leaky = check('leaky', 'readonly', () =>
    Promise.resolve({ verdict: 'pass', evidence: 'rootPassword: hunter2hunter2 ok' })
  )
  const report = await runPlan([{ check: leaky, run: true, reason: '' }], {
    api: nullApi,
    ...silent,
  })
  assertEquals(Object.keys(report.results[0] ?? {}).sort(), ['evidence', 'id', 'verdict'])
  assert(!report.results[0]?.evidence.includes('hunter2'))
  const md = toMarkdown(report, {
    target: TESTING,
    environment: 'testing',
    prefix: 'clr-x',
    apply: true,
    startedAt: 'a',
    finishedAt: 'b',
  })
  assertStringIncludes(md, '| leaky | pass |')
})

Deno.test('redaction strips secret fields and PEM keys', () => {
  const pem = ['-----BEGIN PRIVATE KEY-----', 'abc', '-----END PRIVATE KEY-----'].join('\n')
  const out = redactJson({ rootPassword: 'x', nested: [{ token: 'y', name: 'ok' }], key: pem })
  assertEquals(out, {
    rootPassword: '<redacted>',
    nested: [{ token: '<redacted>', name: 'ok' }],
    key: '<redacted>',
  })
  assertEquals(redactText(`cert ${pem} end`), 'cert <redacted private key> end')
})

Deno.test('road lines never carry skips', () => {
  const lines = roadLines(
    [
      { id: 'a', verdict: 'pass', evidence: 'e' },
      { id: 'b', verdict: 'skip', evidence: 'dry' },
      { id: 'c', verdict: 'fail', evidence: 'f' },
    ],
    'clr-x',
    new Date('2026-10-02T00:00:00Z')
  )
  assertEquals(lines.length, 2)
  const first = JSON.parse(lines[0] ?? '{}')
  assertEquals(first.collection, 'status')
  assertEquals(first.doc_id, 'a')
  assertEquals(first.data.state, 'pass')
})

Deno.test('--tick-road writes the jsonl only when asked', async () => {
  const { d, written } = deps(fakePanel('testing', []), [check('a', 'readonly')])
  await main(['--apply', '--tick-road'], d)
  assert([...written.keys()].some((k) => k.endsWith('.road.jsonl')))
  const second = deps(fakePanel('testing', []), [check('a', 'readonly')])
  await main(['--apply'], second.d)
  assert(![...second.written.keys()].some((k) => k.endsWith('.road.jsonl')))
})

Deno.test('lock: a second run is refused while the first holds it, then released', async () => {
  const fs = memoryLockFs()
  const first = await acquireLock('/tmp/x.lock', fs)
  await assertRejects(() => acquireLock('/tmp/x.lock', fs), LockHeldError)
  await first.release()
  const again = await acquireLock('/tmp/x.lock', fs)
  await again.release()
  assertEquals(fs.files.size, 0)
})

Deno.test('lock: main refuses to apply while another run holds the lock', async () => {
  const lockFs = memoryLockFs()
  const held = await acquireLock('/tmp/turbopanel-checklist-runner.lock', lockFs)
  const { d } = deps(fakePanel('testing', []), [check('a', 'readonly')], { lockFs })
  await assertRejects(() => main(['--apply'], d), LockHeldError)
  await held.release()
  assertEquals(await main(['--apply'], d), 0)
  assertEquals(lockFs.files.size, 0)
})

Deno.test('lock: real file lock with createNew', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const lock = await acquireLock(`${dir}/run.lock`)
    await assertRejects(() => acquireLock(`${dir}/run.lock`), LockHeldError)
    await lock.release()
    await (await acquireLock(`${dir}/run.lock`)).release()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('client: refuses a cross-host redirect and retries once on DNS errors', async () => {
  let attempts = 0
  const flaky: FetchLike = (url) => {
    attempts++
    if (attempts === 1) return Promise.reject(new TypeError('dns error: EAI_AGAIN'))
    if (url.includes('/away')) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
      )
    }
    return Promise.resolve(Response.json({ ok: true }))
  }
  const api = new ApiClient({
    origin: TESTING,
    fetch: flaky,
    readOnly: false,
    sleep: () => Promise.resolve(),
  })
  assertEquals((await api.get('/client/v1/ping')).status, 200)
  assertEquals(attempts, 2)
  await assertRejects(() => api.get('/away'), SafetyError)
})

Deno.test('client: DELETE reauths once when the panel asks for it', async () => {
  const seen: string[] = []
  let deleted = 0
  const panel: FetchLike = (url, init) => {
    seen.push(`${init.method} ${new URL(url).pathname}`)
    if (url.includes('/auth/')) return Promise.resolve(Response.json({}))
    if (url.includes('/organizations')) return Promise.resolve(Response.json([{ id: 'o1' }]))
    deleted++
    return Promise.resolve(
      deleted === 1
        ? Response.json({ error: 'reauth_required' }, { status: 403 })
        : new Response(null, { status: 204 })
    )
  }
  const api = new ApiClient({
    origin: TESTING,
    fetch: panel,
    readOnly: false,
    sleep: () => Promise.resolve(),
  })
  await api.signIn({ email: 'a@example.test', password: runtimePw() })
  assertEquals((await api.del('/client/v1/projects/p1')).status, 204)
  assertEquals(seen.filter((s) => s.includes('/auth/reauth')).length, 1)
})

Deno.test(
  'host gates: studio never, shared Postgres hosts never, managed only on themisto/megaclite',
  () => {
    const refuses = (fn: () => void) => {
      try {
        fn()
        return false
      } catch (error) {
        return error instanceof SafetyError
      }
    }
    assert(refuses(() => assertSshHost('studio.lan', ['studio.lan'])))
    assert(refuses(() => assertSshHost('io.privatehosting.xyz', [])))
    assert(!refuses(() => assertSshHost('io.privatehosting.xyz', ['io.privatehosting.xyz'])))
    assert(refuses(() => assertManagedPlacement('adrastea')))
    assert(refuses(() => assertManagedPlacement('kore.lan')))
    assert(refuses(() => assertManagedPlacement('europa')))
    assert(!refuses(() => assertManagedPlacement('themisto')))
    assert(refuses(() => assertAffectedHost('kore', ['kore'])))
    assert(refuses(() => assertAffectedHost('io', ['europa'])))
    assert(!refuses(() => assertAffectedHost('io.privatehosting.xyz', ['io'])))
  }
)

Deno.test('mail sink accepts only loopback and only GETs', async () => {
  const methods: string[] = []
  const fake: FetchLike = (url, init) => {
    methods.push(init.method ?? 'GET')
    return Promise.resolve(
      url.includes('/search')
        ? Response.json({ messages: [{ ID: 'm1', Subject: 'Verify' }] })
        : Response.json({ Text: 'link https://testing.turbopanel.dev/verify?t=1' })
    )
  }
  let refused = false
  try {
    mailpitSink('http://mail.example.com:8025', fake)
  } catch (error) {
    refused = error instanceof SafetyError
  }
  assert(refused)
  const sink = mailpitSink('http://127.0.0.1:8025', fake)
  assertEquals(await sink.messagesTo('x@example.test'), [{ id: 'm1', subject: 'Verify' }])
  assertStringIncludes(await sink.text('m1'), 'verify')
  assertEquals(methods, ['GET', 'GET'])
})

Deno.test('ssh refuses unnamed hosts and passes strict options', async () => {
  const seen: string[][] = []
  const exec = sshExec({
    allowed: ['io.privatehosting.xyz'],
    user: 'root',
    run: (args) => {
      seen.push(args)
      return Promise.resolve({ code: 0, stdout: 'active\n' })
    },
  })
  assertEquals(await exec('io.privatehosting.xyz', 'systemctl is-active turbopaneld'), 'active\n')
  assert(seen[0]?.includes('StrictHostKeyChecking=yes'))
  await assertRejects(() => exec('studio.lan', 'true'), SafetyError)
})

Deno.test('run prefix is short, unique-ish and marked', () => {
  const now = new Date('2026-10-02T12:00:00Z')
  const a = runPrefix(now, () => 0.1)
  const b = runPrefix(now, () => 0.9)
  assert(a.startsWith('clr-') && a !== b && a.length <= 12)
})

Deno.test(
  'registry: unique row ids, a safety class each, host-affecting never in the default run',
  async () => {
    const { REGISTRY } = await import('./checks/index.ts')
    const ids = REGISTRY.map((c) => c.rowId)
    assertEquals(new Set(ids).size, ids.length)
    assert(REGISTRY.length >= 25)
    const opts = parseArgs(['--apply'], '/tmp')
    const plan = planChecks(REGISTRY, { ...opts, available: new Set(['api', 'mail']) })
    for (const p of plan) {
      assertEquals(p.run, p.check.safety !== 'host-affecting', p.check.rowId)
    }
  }
)

Deno.test('registry dry run: every check is skipped and only health is fetched', async () => {
  const { REGISTRY } = await import('./checks/index.ts')
  const calls: Call[] = []
  const { d, written } = deps(fakePanel('testing', calls), [...REGISTRY])
  assertEquals(await main([], d), 0)
  assertEquals(calls.length, 1)
  const json = [...written].find(([k]) => k.endsWith('.json'))?.[1] ?? '[]'
  assertEquals((JSON.parse(json) as unknown[]).length, REGISTRY.length)
})

Deno.test('host-affecting checks skip without --host and create nothing', async () => {
  const { DEPLOY_CHECKS } = await import('./checks/deploys.ts')
  const { MANAGED_CHECKS } = await import('./checks/managed.ts')
  const seen: string[] = []
  const api: Api = {
    orgId: 'o',
    get: (p) => {
      seen.push(`GET ${p}`)
      return Promise.resolve({ status: 200, body: { servers: [] }, headers: new Headers() })
    },
    post: (p) => Promise.reject(new Error(`unexpected POST ${p}`)),
    put: (p) => Promise.reject(new Error(`unexpected PUT ${p}`)),
    patch: (p) => Promise.reject(new Error(`unexpected PATCH ${p}`)),
    del: (p) => Promise.reject(new Error(`unexpected DELETE ${p}`)),
  }
  const plan = [...DEPLOY_CHECKS, ...MANAGED_CHECKS].map((c) => ({
    check: c,
    run: true,
    reason: '',
  }))
  const report = await runPlan(plan, { api, ...silent })
  for (const r of report.results) assertEquals(r.verdict, 'skip', `${r.id}: ${r.evidence}`)
  assertEquals(report.leftovers, [])
})

Deno.test('managed placement refuses adrastea even when passed with --host', async () => {
  const { managedPgSingle } = await import('./checks/managed.ts')
  const api: Api = {
    ...nullApi,
    get: () =>
      Promise.resolve({
        status: 200,
        body: { servers: [{ id: 's1', hostname: 'adrastea' }] },
        headers: new Headers(),
      }),
  }
  const result = await runOne(managedPgSingle, { api, ...silent, hosts: ['adrastea'] }, [])
  assertEquals(result.verdict, 'skip')
  const themisto = await runOne(
    managedPgSingle,
    {
      api: {
        ...api,
        get: () =>
          Promise.resolve({
            status: 200,
            body: { servers: [{ id: 's1', hostname: 'kore' }] },
            headers: new Headers(),
          }),
      },
      ...silent,
      hosts: ['themisto'],
    },
    []
  )
  assertEquals(themisto.verdict, 'fail')
  assertStringIncludes(themisto.evidence, 'not in this organization')
})

Deno.test('health gate: null environment is accepted only for canary', () => {
  assertEquals(
    assertHealthEnvironment(200, { environment: null }, 'canary.turbopanel.dev'),
    'canary (environment null)'
  )
  let refused = false
  try {
    assertHealthEnvironment(200, { environment: null }, 'testing.turbopanel.dev')
  } catch (error) {
    refused = error instanceof SafetyError
  }
  assert(refused)
  refused = false
  try {
    assertHealthEnvironment(200, { environment: 'live' }, 'canary.turbopanel.dev')
  } catch (error) {
    refused = error instanceof SafetyError
  }
  assert(refused)
})

Deno.test(
  'SIGINT: the running check stops at its next wait, cleans up, the rest skip, lock released',
  async () => {
    let fire: () => void = () => undefined
    const cleaned: string[] = []
    const lockFs = memoryLockFs()
    const waiting = check('waiting', 'creates-objects', async (ctx) => {
      ctx.defer('undo', () => {
        cleaned.push('undo')
        return ctx.sleep(1) // cleanup may still wait after the interrupt
      })
      fire()
      await ctx.sleep(1000)
      return { verdict: 'pass', evidence: 'not reached' }
    })
    const exits: number[] = []
    const { d, written } = deps(fakePanel('testing', []), [waiting, check('later', 'readonly')], {
      lockFs,
      onInterrupt: (handler) => {
        fire = handler
        return () => undefined
      },
      exit: (code) => void exits.push(code),
    })
    const code = await main(['--apply'], d)
    assertEquals(code, 1)
    assertEquals(cleaned, ['undo'])
    const json = [...written].find(([k]) => k.endsWith('.json'))?.[1] ?? '[]'
    const rows = JSON.parse(json) as { id: string; verdict: string; evidence: string }[]
    assertEquals(rows[0]?.verdict, 'fail')
    assertStringIncludes(rows[0]?.evidence ?? '', 'interrupted')
    assertEquals(rows[1]?.verdict, 'skip')
    assertStringIncludes(rows[1]?.evidence ?? '', 'interrupted')
    assertEquals(lockFs.files.size, 0)
    fire()
    assertEquals(exits, [130])
  }
)
