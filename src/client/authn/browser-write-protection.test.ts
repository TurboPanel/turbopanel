import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import { createApp, type AppEnv } from '../../app.ts'
import {
  createBrowserWriteProtectionMiddleware,
  isSameOriginBrowserWrite,
  resolveExpectedBrowserOrigin,
} from '../../browser-write-protection.ts'
import { registerCorsMiddleware } from '../../cors.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  DAEMON_API_PREFIX,
  DEVELOPER_API_PREFIX,
  INSTALL_API_PREFIX,
} from '../../surfaces.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

describe('isSameOriginBrowserWrite', () => {
  it('allows matching Origin', () => {
    assertEquals(
      isSameOriginBrowserWrite(
        'https://panel.example.com',
        undefined,
        'https://panel.example.com',
      ),
      true,
    )
  })

  it('rejects cross-origin Origin', () => {
    assertEquals(
      isSameOriginBrowserWrite(
        'https://evil.example',
        undefined,
        'https://panel.example.com',
      ),
      false,
    )
  })

  it('allows matching Referer when Origin is absent', () => {
    assertEquals(
      isSameOriginBrowserWrite(
        undefined,
        'https://panel.example.com/servers',
        'https://panel.example.com',
      ),
      true,
    )
  })

  it('allows non-browser requests with neither Origin nor Referer', () => {
    assertEquals(
      isSameOriginBrowserWrite(undefined, undefined, 'https://panel.example.com'),
      true,
    )
  })

  it('rejects when expected origin is null', () => {
    assertEquals(
      isSameOriginBrowserWrite('https://panel.example.com', undefined, null),
      false,
    )
  })

  it('rejects malformed Origin / Referer values', () => {
    assertEquals(
      isSameOriginBrowserWrite('not a url', undefined, 'https://panel.example.com'),
      false,
    )
    assertEquals(
      isSameOriginBrowserWrite(
        undefined,
        'also not a url',
        'https://panel.example.com',
      ),
      false,
    )
  })
})

describe('browser write protection residual branches', () => {
  it('passes through non-write methods', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.get(`${CLIENT_API_PREFIX}/status`, (c) => c.json({ ok: true }))

    const res = await app.request(
      new Request('https://panel.example.com/api/client/v1/status', {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      }),
    )
    assertEquals(res.status, 200)
  })

  it('forbids writes when the request URL cannot be parsed', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.post(`${CLIENT_API_PREFIX}/auth/sign-in`, (c) => c.json({ ok: true }))

    // Hono normally always has a parseable URL; force the middleware catch by
    // stubbing c.req.url via a custom request target that throws in URL().
    const middleware = createBrowserWriteProtectionMiddleware('workers')
    const fakeContext = {
      req: {
        method: 'POST',
        url: 'http://[',
        header: () => undefined,
      },
      json: (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 }),
    }
    const res = await middleware(
      fakeContext as never,
      (() => Promise.resolve()) as never,
    )
    assertEquals(res instanceof Response ? res.status : 0, 403)
  })
})

describe('browser write protection middleware', () => {
  it('rejects cross-origin credentialed client writes and allows same-origin', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.post(`${CLIENT_API_PREFIX}/auth/sign-in`, (c) => c.json({ ok: true }))

    const cross = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'https://docs.evil.example',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(cross.status, 403)

    const same = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'https://panel.example.com',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(same.status, 200)
  })

  it('protects admin and install write prefixes', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.put(`${ADMIN_API_PREFIX}/settings/signup`, (c) => c.json({ ok: true }))
    app.post(`${INSTALL_API_PREFIX}/bootstrap`, (c) => c.json({ ok: true }))

    const adminCross = await app.request(
      new Request('https://panel.example.com/api/admin/v1/settings/signup', {
        method: 'PUT',
        headers: { Origin: 'https://docs.example.com' },
        body: '{}',
      }),
    )
    assertEquals(adminCross.status, 403)

    const installCross = await app.request(
      new Request('https://panel.example.com/api/install/v1/bootstrap', {
        method: 'POST',
        headers: { Origin: 'https://docs.example.com' },
        body: '{}',
      }),
    )
    assertEquals(installCross.status, 403)
  })

  it('rejects cross-origin developer writes; allows same-origin and non-browser', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.post(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, (c) => c.json({ ok: true }))

    const cross = await app.request(
      new Request('https://panel.example.com/api/developer/v1/daemon/sync-dev', {
        method: 'POST',
        headers: {
          Origin: 'https://docs.evil.example',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(cross.status, 403)

    const same = await app.request(
      new Request('https://panel.example.com/api/developer/v1/daemon/sync-dev', {
        method: 'POST',
        headers: {
          Origin: 'https://panel.example.com',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(same.status, 200)

    const nonBrowser = await app.request(
      new Request('https://panel.example.com/api/developer/v1/daemon/sync-dev', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    assertEquals(nonBrowser.status, 200)
  })

  it('does not gate daemon bearer routes', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.post(`${DAEMON_API_PREFIX}/auth/session`, (c) => c.json({ ok: true }))

    const res = await app.request(
      new Request('https://panel.example.com/api/daemon/v1/auth/session', {
        method: 'POST',
        headers: { Origin: 'https://docs.evil.example' },
        body: '{}',
      }),
    )
    assertEquals(res.status, 200)
  })

  it('Deno proxy-style HTTPS Origin matches X-Forwarded-Proto + Host', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('deno'))
    app.post(`${CLIENT_API_PREFIX}/auth/sign-in`, (c) => c.json({ ok: true }))

    // Unix-socket / internal URL origin differs from the browser HTTPS origin.
    const res = await app.request(
      new Request('http://localhost/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'https://panel.example.com',
          Host: 'panel.example.com',
          'X-Forwarded-Proto': 'https',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(res.status, 200)
  })

  it('Workers ignores spoofed X-Forwarded-Proto for origin checks', async () => {
    const app = new Hono()
    app.use('*', createBrowserWriteProtectionMiddleware('workers'))
    app.post(`${CLIENT_API_PREFIX}/auth/sign-in`, (c) => c.json({ ok: true }))

    // Spoofed http forwarded-proto must not make http Origin pass against an
    // https request URL — Workers trusts the URL only.
    const res = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'http://panel.example.com',
          'X-Forwarded-Proto': 'http',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    assertEquals(res.status, 403)
  })

  it('resolveExpectedBrowserOrigin returns null for unparseable request URLs', () => {
    const badCtx = {
      req: {
        header: () => undefined,
        url: 'http://[',
      },
    } as unknown as Parameters<typeof resolveExpectedBrowserOrigin>[0]
    assertEquals(resolveExpectedBrowserOrigin(badCtx, 'workers'), null)
  })

  it('resolveExpectedBrowserOrigin uses proxy signal on Deno only', () => {
    const denoReq = new Request('http://localhost/api/client/v1/auth/sign-in', {
      headers: {
        Host: 'panel.example.com:8443',
        'X-Forwarded-Proto': 'https',
      },
    })
    const denoCtx = {
      req: {
        url: denoReq.url,
        header: (name: string) => denoReq.headers.get(name) ?? undefined,
      },
    } as unknown as Parameters<typeof resolveExpectedBrowserOrigin>[0]
    assertEquals(
      resolveExpectedBrowserOrigin(denoCtx, 'deno'),
      'https://panel.example.com:8443',
    )

    const workersReq = new Request(
      'https://panel.example.com/api/client/v1/auth/sign-in',
      {
        headers: {
          Host: 'evil.example',
          'X-Forwarded-Proto': 'http',
        },
      },
    )
    const workersCtx = {
      req: {
        url: workersReq.url,
        header: (name: string) => workersReq.headers.get(name) ?? undefined,
      },
    } as unknown as Parameters<typeof resolveExpectedBrowserOrigin>[0]
    assertEquals(
      resolveExpectedBrowserOrigin(workersCtx, 'workers'),
      'https://panel.example.com',
    )
  })

  it('createApp mounts write protection before client routes', async () => {
    const secretsConfig = parseSecretsEnv(
      TEST_ONLY_TURBOPANEL_SECRET,
      undefined,
      'workers',
    )
    const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
    const otpVerifierSecrets = await deriveSecretsConfig(
      secretsConfig,
      'email-otp-verifier',
    )
    const app = createApp({
      secrets,
      otpVerifierSecrets,
      runtime: 'workers',
      signupEnvOverride: undefined,
    })

    const cross = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'https://docs.example.com',
          'content-type': 'application/json',
          'CF-Connecting-IP': '203.0.113.40',
        },
        body: JSON.stringify({ username: 'a@example.com', password: 'x' }),
      }),
    )
    assertEquals(cross.status, 403)

    // Same-origin reaches the auth handler (no DB → 401/429/503 — not 403).
    const same = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'POST',
        headers: {
          Origin: 'https://panel.example.com',
          'content-type': 'application/json',
          'CF-Connecting-IP': '203.0.113.40',
        },
        body: JSON.stringify({ username: 'a@example.com', password: 'x' }),
      }),
    )
    assertEquals(same.status === 403, false)
  })
})

describe('CORS read-only methods for docs origins', () => {
  it('preflight for POST does not advertise write methods', async () => {
    const app = new Hono<AppEnv>()
    registerCorsMiddleware(app, 'https://docs.example.com')
    app.post('/api/client/v1/auth/sign-in', (c) => c.json({ ok: true }))

    const preflight = await app.request(
      new Request('https://panel.example.com/api/client/v1/auth/sign-in', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://docs.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }),
    )
    assertEquals(preflight.status, 204)
    const allowed = preflight.headers.get('Access-Control-Allow-Methods') ?? ''
    assertEquals(allowed.includes('POST'), false)
    assertEquals(allowed.includes('GET'), true)
  })

  it('emits Vary: Origin for allowed and disallowed origins', async () => {
    const app = new Hono<AppEnv>()
    registerCorsMiddleware(app, 'https://docs.example.com')
    app.get('/api/client/v1/status', (c) => c.json({ ok: true }))

    const allowedGet = await app.request(
      new Request('https://panel.example.com/api/client/v1/status', {
        method: 'GET',
        headers: { Origin: 'https://docs.example.com' },
      }),
    )
    assertEquals(allowedGet.status, 200)
    assertEquals(allowedGet.headers.get('Vary'), 'Origin')
    assertEquals(
      allowedGet.headers.get('Access-Control-Allow-Origin'),
      'https://docs.example.com',
    )
    assertEquals(allowedGet.headers.get('Access-Control-Allow-Credentials'), 'true')

    const deniedGet = await app.request(
      new Request('https://panel.example.com/api/client/v1/status', {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      }),
    )
    assertEquals(deniedGet.status, 200)
    assertEquals(deniedGet.headers.get('Vary'), 'Origin')
    assertEquals(deniedGet.headers.get('Access-Control-Allow-Origin'), null)
    assertEquals(deniedGet.headers.get('Access-Control-Allow-Credentials'), null)

    const deniedOptions = await app.request(
      new Request('https://panel.example.com/api/client/v1/status', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    )
    assertEquals(deniedOptions.status, 204)
    assertEquals(deniedOptions.headers.get('Vary'), 'Origin')
    assertEquals(deniedOptions.headers.get('Access-Control-Allow-Origin'), null)
    assertEquals(
      deniedOptions.headers.get('Access-Control-Allow-Credentials'),
      null,
    )
  })
})

test('browser write protection suite loaded', () => {
  assertEquals(typeof createBrowserWriteProtectionMiddleware, 'function')
})
