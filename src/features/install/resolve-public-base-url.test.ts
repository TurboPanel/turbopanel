import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { instanceHostname } from '../../db/schema.ts'
import { setSelfHostedAddress } from './ingress-modes.ts'
import {
  parseInstallBaseUrl,
  resolveInstallBaseUrl,
  resolvePublicBaseUrl,
  resolveSelfHostedConsoleBaseUrl,
} from './resolve-public-base-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Run `fn` with the two hostname variables set (or deleted) and restore them after. */
async function withHostnameEnv(
  values: Readonly<{ TURBOPANEL_BASE_URL?: string; TURBOPANEL_PUBLIC_URLS?: string }>,
  fn: () => Promise<void>
): Promise<void> {
  const keys = ['TURBOPANEL_BASE_URL', 'TURBOPANEL_PUBLIC_URLS'] as const
  const previous = keys.map((key) => Deno.env.get(key))
  for (const key of keys) {
    const value = values[key]
    if (value === undefined) Deno.env.delete(key)
    else Deno.env.set(key, value)
  }
  try {
    await fn()
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index]
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    })
  }
}

test('parseInstallBaseUrl keeps an already valid https origin and dials :8443 for a bare host', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com'), 'https://panel.example.com')
  assertEquals(parseInstallBaseUrl('https://turbopanel.app'), 'https://turbopanel.app')
  assertEquals(parseInstallBaseUrl('https://turbopanel.app:443'), 'https://turbopanel.app')
  assertEquals(
    parseInstallBaseUrl('https://panel.example.com:8443'),
    'https://panel.example.com:8443'
  )
  assertEquals(parseInstallBaseUrl('panel.example.com'), 'https://panel.example.com:8443')
})

test('parseInstallBaseUrl rejects plaintext http', () => {
  assertEquals(parseInstallBaseUrl('http://panel.example.com'), null)
})

test('parseInstallBaseUrl rejects paths, query strings, and shell metacharacters', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com; curl http://evil'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/path'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com?x=$(id)'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/`whoami`'), null)
})

test('resolvePublicBaseUrl prefers opts.baseUrl over forwarded headers', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('platformEnv', {})
    return c.text(
      await resolvePublicBaseUrl(c, {
        baseUrl: 'https://preferred.example.com',
      })
    )
  })
  const res = await app.request('https://internal.invalid/t', {
    headers: {
      'x-forwarded-host': 'ignored.example.com',
      'x-forwarded-proto': 'https',
    },
  })
  assertEquals(await res.text(), 'https://preferred.example.com')
})

test('resolvePublicBaseUrl reads TURBOPANEL_BASE_URL from platformEnv on Workers', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('runtime', 'workers')
    c.set('platformEnv', {
      TURBOPANEL_BASE_URL: 'https://workers.example.com',
    })
    return c.text(await resolvePublicBaseUrl(c))
  })
  const res = await app.request('https://internal.invalid/t')
  assertEquals(await res.text(), 'https://workers.example.com')
})

test('parseInstallBaseUrl rejects blank candidates', () => {
  assertEquals(parseInstallBaseUrl(undefined), null)
  assertEquals(parseInstallBaseUrl('   '), null)
})

test('self-hosted: TURBOPANEL_BASE_URL in the process env is never the address', async () => {
  await withHostnameEnv(
    { TURBOPANEL_BASE_URL: 'https://env.example.com', TURBOPANEL_PUBLIC_URLS: undefined },
    async () => {
      const app = new Hono<AppEnv>()
      app.get('/t', async (c) => {
        c.set('runtime', 'deno')
        c.set('platformEnv', {})
        return c.text(await resolvePublicBaseUrl(c))
      })
      const res = await app.request('https://internal.invalid/t', {
        headers: {
          'x-forwarded-host': 'forwarded.example.com',
          'x-forwarded-proto': 'https',
        },
      })
      assertEquals(await res.text(), 'https://forwarded.example.com')
    }
  )
})

test('resolvePublicBaseUrl accepts https forwarded host when env is unset', async () => {
  const previousBase = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.delete('TURBOPANEL_BASE_URL')
  Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
  try {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c))
    })
    const res = await app.request('https://internal.invalid/t', {
      headers: {
        'x-forwarded-host': 'edge.example.com',
        'x-forwarded-proto': 'https',
      },
    })
    assertEquals(await res.text(), 'https://edge.example.com')
  } finally {
    if (previousBase === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previousBase)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
})

test('a mailed link never takes its host from the request, even with nothing configured', async () => {
  const previousBase = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.delete('TURBOPANEL_BASE_URL')
  Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
  try {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c, { allowRequestHost: false }))
    })
    const res = await app.request('https://evil.example/t', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    })
    const origin = await res.text()
    assertEquals(origin.includes('evil.example'), false)
    assertEquals(origin.endsWith(':8443'), true)
  } finally {
    if (previousBase === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previousBase)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
})

test('a configured base URL still wins for mailed links', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('platformEnv', {})
    return c.text(
      await resolvePublicBaseUrl(c, {
        baseUrl: 'https://panel.example.com',
        allowRequestHost: false,
      })
    )
  })
  const res = await app.request('https://evil.example/t', {
    headers: { 'x-forwarded-host': 'evil.example' },
  })
  assertEquals(await res.text(), 'https://panel.example.com')
})

test('self-hosted: env hostnames are not injected; with no rows a mailed link uses the discovered address', async () => {
  await withHostnameEnv(
    {
      TURBOPANEL_BASE_URL: 'https://env-base.example.com',
      TURBOPANEL_PUBLIC_URLS: 'https://public.example.com,secondary.example.com',
    },
    async () => {
      const app = new Hono<AppEnv>()
      app.get('/t', async (c) => {
        c.set('runtime', 'deno')
        c.set('platformEnv', {})
        c.set('db', dbWithHostnames([]))
        return c.text(await resolvePublicBaseUrl(c, { allowRequestHost: false }))
      })
      const origin = await (await app.request('https://internal.invalid/t')).text()
      assertEquals(origin.includes('example.com'), false)
      assertEquals(origin.endsWith(':8443'), true)
    }
  )
})

type StoredRow = { host: string; publicPort: number; isPrimary: boolean; isDaemonDial: boolean }

/** A database whose hostname table holds `rows` in creation order. */
function dbWithHostnames(rows: StoredRow[]): Db {
  const stored = rows.map((row, index) => ({
    id: `host-${index}`,
    source: 'platform-ca',
    mode: 'direct',
    uploadedCertId: null,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    ingressId: null,
    ingressState: null,
    createdAt: new Date(index).toISOString(),
    updatedAt: new Date(index).toISOString(),
    ...row,
  }))
  const result = (table: unknown) => {
    const promise = Promise.resolve(table === instanceHostname ? stored : [])
    return Object.assign(promise, { limit: () => promise, orderBy: () => promise })
  }
  return {
    select: () => ({ from: (table: unknown) => ({ where: () => result(table) }) }),
  } as unknown as Db
}

async function resolveWith(rows: StoredRow[], install = false): Promise<string> {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('platformEnv', {})
    c.set('db', dbWithHostnames(rows))
    return c.text(await (install ? resolveInstallBaseUrl(c) : resolvePublicBaseUrl(c)))
  })
  return await (await app.request('https://internal.invalid/t')).text()
}

const OLD_ROW = { host: 'old.example.test', publicPort: 8443, isPrimary: false, isDaemonDial: true }
const PRIMARY_ROW = {
  host: 'new.example.test',
  publicPort: 443,
  isPrimary: true,
  isDaemonDial: true,
}

test('with no primary the oldest hostname wins at its default port, as before public ports', async () => {
  assertEquals(
    await resolveWith([OLD_ROW, { ...PRIMARY_ROW, isPrimary: false }]),
    'https://old.example.test:8443'
  )
})

test('the primary hostname wins and shows no port on 443', async () => {
  assertEquals(await resolveWith([OLD_ROW, PRIMARY_ROW]), 'https://new.example.test')
})

test('the install base skips a primary that servers do not dial', async () => {
  assertEquals(await resolveWith([OLD_ROW, PRIMARY_ROW], true), 'https://new.example.test')
  assertEquals(
    await resolveWith([OLD_ROW, { ...PRIMARY_ROW, isDaemonDial: false }], true),
    'https://old.example.test:8443'
  )
})

test('a bare stored hostname dials :8443', async () => {
  assertEquals(
    await resolveWith([
      { host: 'panel.lan', publicPort: 8443, isPrimary: true, isDaemonDial: true },
    ]),
    'https://panel.lan:8443'
  )
})

test('Workers: a stored row is ignored, the platform origin wins without a port', async () => {
  for (const install of [false, true]) {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('runtime', 'workers')
      c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://hosted.example.com:443' })
      c.set('db', dbWithHostnames([PRIMARY_ROW, OLD_ROW]))
      return c.text(await (install ? resolveInstallBaseUrl(c) : resolvePublicBaseUrl(c)))
    })
    const origin = await (await app.request('https://internal.invalid/t')).text()
    assertEquals(origin, 'https://hosted.example.com', `install=${install}`)
  }
})

test('Workers: TURBOPANEL_PUBLIC_URLS names the origin when the base URL is unset', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('runtime', 'workers')
    c.set('platformEnv', { TURBOPANEL_PUBLIC_URLS: 'hosted.example.com:8443,other.example.com' })
    c.set('db', dbWithHostnames([PRIMARY_ROW]))
    return c.text(await resolvePublicBaseUrl(c))
  })
  assertEquals(
    await (await app.request('https://internal.invalid/t')).text(),
    'https://hosted.example.com'
  )
})

test('resolveSelfHostedConsoleBaseUrl follows the saved primary hostname', async () => {
  assertEquals(
    await resolveSelfHostedConsoleBaseUrl(dbWithHostnames([OLD_ROW, PRIMARY_ROW])),
    'https://new.example.test'
  )
  assertEquals(
    await resolveSelfHostedConsoleBaseUrl(dbWithHostnames([OLD_ROW])),
    'https://old.example.test:8443'
  )
  await withHostnameEnv({ TURBOPANEL_BASE_URL: 'https://env.example.com' }, async () => {
    const fallback = await resolveSelfHostedConsoleBaseUrl(dbWithHostnames([]))
    assertEquals(fallback.includes('env.example.com'), false)
    assertEquals(fallback.endsWith(':8443'), true)
  })
})

test('self-hosted: a forwarded host or base URL on 443 resolves to the :8443 address', async () => {
  const previousBase = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.delete('TURBOPANEL_BASE_URL')
  Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
  setSelfHostedAddress(true)
  try {
    const app = new Hono<AppEnv>()
    app.get('/forwarded', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c))
    })
    app.get('/configured', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c, { baseUrl: 'https://panel.example.com:443' }))
    })
    const forwarded = await app.request('https://panel.example.test/forwarded', {
      headers: { 'x-forwarded-host': 'panel.example.test' },
    })
    assertEquals(await forwarded.text(), 'https://panel.example.test:8443')
    const configured = await app.request('https://panel.example.test/configured')
    assertEquals(await configured.text(), 'https://panel.example.com:8443')
  } finally {
    setSelfHostedAddress(false)
    if (previousBase === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previousBase)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
})
