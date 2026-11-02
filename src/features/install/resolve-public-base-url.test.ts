import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { instanceHostname } from '../../db/schema.ts'
import {
  parseInstallBaseUrl,
  resolveInstallBaseUrl,
  resolvePublicBaseUrl,
} from './resolve-public-base-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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

test('resolvePublicBaseUrl prefers Deno TURBOPANEL_BASE_URL over forwarded headers', async () => {
  const previous = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.set('TURBOPANEL_BASE_URL', 'https://env.example.com')
  Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
  try {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c))
    })
    const res = await app.request('https://internal.invalid/t', {
      headers: {
        'x-forwarded-host': 'ignored.example.com',
        'x-forwarded-proto': 'https',
      },
    })
    assertEquals(await res.text(), 'https://env.example.com')
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previous)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
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

test('resolvePublicBaseUrl dials 8443 for the first TURBOPANEL_PUBLIC_URLS entry, even written as https://host', async () => {
  const previousBase = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.delete('TURBOPANEL_BASE_URL')
  Deno.env.set('TURBOPANEL_PUBLIC_URLS', 'https://public.example.com,https://secondary.example.com')
  try {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c))
    })
    const res = await app.request('https://internal.invalid/t')
    assertEquals(await res.text(), 'https://public.example.com:8443')
  } finally {
    if (previousBase === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previousBase)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
})

test('resolvePublicBaseUrl dials :8443 for a bare stored hostname', async () => {
  const previousBase = Deno.env.get('TURBOPANEL_BASE_URL')
  const previousPublic = Deno.env.get('TURBOPANEL_PUBLIC_URLS')
  Deno.env.delete('TURBOPANEL_BASE_URL')
  Deno.env.set('TURBOPANEL_PUBLIC_URLS', 'panel.lan')
  try {
    const app = new Hono<AppEnv>()
    app.get('/t', async (c) => {
      c.set('platformEnv', {})
      return c.text(await resolvePublicBaseUrl(c))
    })
    const res = await app.request('https://internal.invalid/t')
    assertEquals(await res.text(), 'https://panel.lan:8443')
  } finally {
    if (previousBase === undefined) Deno.env.delete('TURBOPANEL_BASE_URL')
    else Deno.env.set('TURBOPANEL_BASE_URL', previousBase)
    if (previousPublic === undefined) Deno.env.delete('TURBOPANEL_PUBLIC_URLS')
    else Deno.env.set('TURBOPANEL_PUBLIC_URLS', previousPublic)
  }
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
