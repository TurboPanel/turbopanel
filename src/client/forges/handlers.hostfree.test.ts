/**
 * Host-free coverage for the shared forge handlers.
 *
 * Drizzle is a thenable chain; public-URL rows and forge rows are distinguished
 * by the table object passed to `from()`. GitHub HTTP is stubbed via fetch.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { setting } from '../../lib/db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { signGithubManifestState } from '../repositories/provider-install-state.ts'
import type { GithubManifestStateClaims } from '../repositories/provider-install-state.ts'
import { registerForgeRoutes } from './routes.ts'
import {
  completeGithubManifestHandler,
  createForgeHandler,
  deleteForgeHandler,
  getForgeHandler,
  listForgesHandler,
  patchForgeHandler,
  startGithubManifestHandler,
  syncForgeHandler,
  type ForgeScope,
} from './handlers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const APP_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-03-01T00:00:00.000Z'
const ADMIN: ForgeScope = { organizationId: null }
const ORG: ForgeScope = { organizationId: ORG_ID }

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate'), { code: '23505' })
}

function appRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP_ID,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: null,
    options: null,
    organizationId: ORG_ID,
    provider: 'github',
    name: 'TurboPanel',
    baseUrl: 'https://github.com',
    apiUrl: null,
    externalAppId: '1234',
    appSlug: 'turbo',
    clientId: 'Iv1.abc',
    redirectUri: null,
    webhookOrigin: null,
    isPublic: false,
    customGitUser: null,
    customGitPort: null,
    syncedAt: null,
    envelopes: {},
    webhookRef: 'ref-1',
    webhookTokenHash: null,
    ...overrides,
  }
}

type FakeDbConfig = {
  publicUrls?: string[] | string
  appRows?: Record<string, unknown>[]
  visible?: Array<{ id: string; organizationId: string | null }>
  insertError?: Error
  updateError?: Error
  updateEmpty?: boolean
  deleteEmpty?: boolean
}

function fakeDb(config: FakeDbConfig = {}): Db {
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === setting) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  config.publicUrls === undefined ? [] : [{ value: config.publicUrls }],
                ),
            }),
          }
        }
        const rows = config.appRows ?? []
        const visible = config.visible ??
          rows.map((row) => ({
            id: String(row.id),
            organizationId: (row.organizationId ?? null) as string | null,
          }))
        const projected = fields !== undefined
        return {
          where: () => ({
            limit: () => Promise.resolve(projected ? visible : rows),
            orderBy: () => Promise.resolve(rows),
          }),
          orderBy: () => Promise.resolve(rows),
        }
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          if (config.insertError) throw config.insertError
          return Promise.resolve([appRow({ ...values, id: APP_ID })])
        },
      }),
    }),
    update: () => ({
      set: (next: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            if (config.updateError) throw config.updateError
            if (config.updateEmpty) return Promise.resolve([])
            const base = config.appRows?.[0] ?? appRow()
            return Promise.resolve([appRow({ ...base, ...next })])
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve(config.deleteEmpty ? [] : [{ id: APP_ID }]),
      }),
    }),
  } as unknown as Db
}

async function encryption() {
  return await deriveEncryptionSecretsConfig(parseTestSecretsConfig('deno'), 'data-encryption')
}

const secretsConfig = parseTestSecretsConfig('deno')

type InvokeOpts = {
  db?: Db
  scope?: ForgeScope
  method?: string
  path?: string
  body?: unknown
  rawBody?: string
  secrets?: boolean
  encrypt?: boolean
}

async function invoke(
  run: (c: Context<AppEnv>) => Promise<Response>,
  opts: InvokeOpts = {},
): Promise<Response> {
  const app = new Hono<AppEnv>()
  const dataEncryptionSecrets = opts.encrypt === false ? undefined : await encryption()
  app.use('*', async (c, next) => {
    if (opts.secrets !== false) c.set('secretsConfig', secretsConfig)
    if (dataEncryptionSecrets) c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    await next()
  })
  app.onError((error, c) => c.json({ error: error.message }, 500))
  app.all('*', (c) => run(c))

  const headers: Record<string, string> = {}
  let body: string | undefined
  if (opts.rawBody !== undefined) {
    headers['content-type'] = 'application/json'
    body = opts.rawBody
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  return await app.request(opts.path ?? 'http://tp.test/forges', {
    method: opts.method ?? 'GET',
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body === undefined ? {} : { body }),
  })
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new TypeError('expected a JSON object')
  }
  return body as Record<string, unknown>
}

function withFetch(
  handler: (url: string) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

async function generatePkcs8Pem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const bytes = new Uint8Array(pkcs8)
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  const body = btoa(binary).replaceAll(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

let cachedPem: Promise<string> | undefined
function pkcs8Pem(): Promise<string> {
  cachedPem ??= generatePkcs8Pem()
  return cachedPem
}

test('registerForgeRoutes refuses to mount without session secrets', () => {
  assertThrows(
    () =>
      registerForgeRoutes(new Hono<AppEnv>(), {
        runtime: 'deno',
        signupEnvOverride: undefined,
      }),
    TypeError,
    'session secrets are required for git app routes',
  )
})

test('list serializes visible apps against the first usable public origin', async () => {
  const response = await invoke(
    (c) =>
      listForgesHandler(
        c,
        fakeDb({
          publicUrls: ['https://panel.example.com/', 'https://hooks.example.com'],
          appRows: [appRow()],
        }),
        ORG,
      ),
  )
  assertEquals(response.status, 200)
  const body = await jsonOf(response)
  const apps = body.apps
  if (!Array.isArray(apps) || apps[0] === undefined) {
    throw new TypeError('expected apps[]')
  }
  const first = apps[0] as Record<string, unknown>
  assertEquals(first.readOnly, false)
  assertEquals(first.webhookUrl, 'https://panel.example.com/webhook/github')
})

test('list prefers an https origin and marks instance-wide apps read-only', async () => {
  const response = await invoke(
    (c) =>
      listForgesHandler(
        c,
        fakeDb({
          publicUrls: 'ftp://ignored.example.com, https://panel.example.com',
          appRows: [appRow({ organizationId: null })],
        }),
        ORG,
      ),
  )
  const body = await jsonOf(response)
  const apps = body.apps
  if (!Array.isArray(apps) || apps[0] === undefined) {
    throw new TypeError('expected apps[]')
  }
  assertEquals((apps[0] as Record<string, unknown>).readOnly, true)
})

test('get rejects a non-uuid, a hidden row, and a vanished summary', async () => {
  const badId = await invoke((c) => getForgeHandler(c, fakeDb(), ORG, 'not-a-uuid'))
  assertEquals(badId.status, 404)

  const hidden = await invoke((c) =>
    getForgeHandler(
      c,
      fakeDb({ visible: [], appRows: [appRow()] }),
      ORG,
      APP_ID,
    )
  )
  assertEquals(hidden.status, 404)

  const vanished = await invoke((c) =>
    getForgeHandler(
      c,
      fakeDb({
        visible: [{ id: APP_ID, organizationId: ORG_ID }],
        appRows: [],
      }),
      ORG,
      APP_ID,
    )
  )
  assertEquals(vanished.status, 404)
})

test('get returns the serialized app when the row is visible', async () => {
  const response = await invoke((c) =>
    getForgeHandler(
      c,
      fakeDb({
        publicUrls: ['https://panel.example.com'],
        appRows: [appRow()],
      }),
      ORG,
      APP_ID,
    )
  )
  assertEquals(response.status, 200)
  const body = await jsonOf(response)
  const app = body.app
  if (typeof app !== 'object' || app === null) {
    throw new TypeError('expected app')
  }
  assertEquals((app as Record<string, unknown>).id, APP_ID)
})

test('create requires encryption and a well-formed body', async () => {
  const noKey = await invoke(
    (c) => createForgeHandler(c, fakeDb(), ORG),
    { encrypt: false, method: 'POST', body: {} },
  )
  assertEquals(noKey.status, 503)
  assertEquals((await jsonOf(noKey)).error, 'Encryption unavailable')

  const invalid = await invoke(
    (c) => createForgeHandler(c, fakeDb(), ORG),
    { method: 'POST', rawBody: '{' },
  )
  assertEquals(invalid.status, 400)
})

test('create maps conflict, validation, and unexpected write failures', async () => {
  const body = { provider: 'github', name: 'Acme', externalAppId: '99' }

  const conflict = await invoke(
    (c) => createForgeHandler(c, fakeDb({ insertError: uniqueViolation() }), ORG),
    { method: 'POST', body },
  )
  assertEquals(conflict.status, 409)

  const shortToken = await invoke(
    (c) => createForgeHandler(c, fakeDb(), ORG),
    {
      method: 'POST',
      body: { provider: 'gitlab', name: 'Acme', externalAppId: '99', webhookSecret: 'too-short' },
    },
  )
  assertEquals(shortToken.status, 400)

  const unexpected = await invoke(
    (c) =>
      createForgeHandler(
        c,
        fakeDb({ insertError: new TypeError('disk full') }),
        ORG,
      ),
    { method: 'POST', body },
  )
  assertEquals(unexpected.status, 500)
})

test('create writes the row under the handler scope and answers 201', async () => {
  const response = await invoke(
    (c) =>
      createForgeHandler(
        c,
        fakeDb({ publicUrls: ['https://panel.example.com'] }),
        ORG,
      ),
    {
      method: 'POST',
      body: { provider: 'github', name: 'Acme', externalAppId: '99' },
    },
  )
  assertEquals(response.status, 201)
  const payload = await jsonOf(response)
  const app = payload.app
  if (typeof app !== 'object' || app === null) {
    throw new TypeError('expected created app')
  }
  assertEquals((app as Record<string, unknown>).organizationId, ORG_ID)
  assertEquals((app as Record<string, unknown>).name, 'Acme')
})

test('patch refuses a bad id, missing encryption, a hidden row, and a foreign write', async () => {
  const badId = await invoke((c) => patchForgeHandler(c, fakeDb(), ORG, 'nope'), {
    method: 'PATCH',
    body: { name: 'Renamed' },
  })
  assertEquals(badId.status, 404)

  const noKey = await invoke(
    (c) => patchForgeHandler(c, fakeDb({ appRows: [appRow()] }), ORG, APP_ID),
    { encrypt: false, method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(noKey.status, 503)

  const hidden = await invoke(
    (c) => patchForgeHandler(c, fakeDb({ visible: [], appRows: [appRow()] }), ORG, APP_ID),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(hidden.status, 404)

  const denied = await invoke(
    (c) =>
      patchForgeHandler(
        c,
        fakeDb({
          visible: [{ id: APP_ID, organizationId: null }],
          appRows: [appRow({ organizationId: null })],
        }),
        ORG,
        APP_ID,
      ),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(denied.status, 403)
  assertEquals((await jsonOf(denied)).error, 'git_app_not_writable')
})

test('patch maps invalid body, missing row, conflict, and ForgeError', async () => {
  const owned = fakeDb({ appRows: [appRow()] })

  const invalid = await invoke(
    (c) => patchForgeHandler(c, owned, ORG, APP_ID),
    { method: 'PATCH', body: { name: '' } },
  )
  assertEquals(invalid.status, 400)

  const vanished = await invoke(
    (c) =>
      patchForgeHandler(
        c,
        fakeDb({
          visible: [{ id: APP_ID, organizationId: ORG_ID }],
          appRows: [],
        }),
        ORG,
        APP_ID,
      ),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(vanished.status, 404)

  const conflict = await invoke(
    (c) =>
      patchForgeHandler(c, fakeDb({ appRows: [appRow()], updateError: uniqueViolation() }), ORG, APP_ID),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(conflict.status, 409)

  const gitlab = appRow({ provider: 'gitlab' })
  const badToken = await invoke(
    (c) => patchForgeHandler(c, fakeDb({ appRows: [gitlab] }), ORG, APP_ID),
    { method: 'PATCH', body: { webhookSecret: 'short' } },
  )
  assertEquals(badToken.status, 400)
})

test('patch returns the updated app and rethrows unexpected write errors', async () => {
  const ok = await invoke(
    (c) =>
      patchForgeHandler(
        c,
        fakeDb({
          publicUrls: ['https://panel.example.com'],
          appRows: [appRow()],
        }),
        ORG,
        APP_ID,
      ),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(ok.status, 200)
  const payload = await jsonOf(ok)
  const app = payload.app
  if (typeof app !== 'object' || app === null) {
    throw new TypeError('expected patched app')
  }
  assertEquals((app as Record<string, unknown>).name, 'Renamed')

  const emptyReturn = await invoke(
    (c) =>
      patchForgeHandler(
        c,
        fakeDb({ appRows: [appRow()], updateEmpty: true }),
        ORG,
        APP_ID,
      ),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(emptyReturn.status, 404)

  const unexpected = await invoke(
    (c) =>
      patchForgeHandler(
        c,
        fakeDb({ appRows: [appRow()], updateError: new TypeError('io') }),
        ORG,
        APP_ID,
      ),
    { method: 'PATCH', body: { name: 'Renamed' } },
  )
  assertEquals(unexpected.status, 500)
})

test('delete is 404 unless the caller can see and write the row, then 204', async () => {
  const badId = await invoke((c) => deleteForgeHandler(c, fakeDb(), ORG, 'nope'))
  assertEquals(badId.status, 404)

  const hidden = await invoke((c) =>
    deleteForgeHandler(c, fakeDb({ visible: [] }), ORG, APP_ID)
  )
  assertEquals(hidden.status, 404)

  const denied = await invoke((c) =>
    deleteForgeHandler(
      c,
      fakeDb({ visible: [{ id: APP_ID, organizationId: null }] }),
      ORG,
      APP_ID,
    )
  )
  assertEquals(denied.status, 403)

  const gone = await invoke((c) =>
    deleteForgeHandler(c, fakeDb({ appRows: [appRow()] }), ORG, APP_ID)
  )
  assertEquals(gone.status, 204)
  assertEquals(gone.body, null)
})

test('sync refuses a bad id, missing encryption, a hidden or read-only row, and gitlab', async () => {
  const badId = await invoke((c) => syncForgeHandler(c, fakeDb(), ORG, 'nope'), {
    method: 'POST',
  })
  assertEquals(badId.status, 404)

  const noKey = await invoke(
    (c) => syncForgeHandler(c, fakeDb({ appRows: [appRow()] }), ORG, APP_ID),
    { encrypt: false, method: 'POST' },
  )
  assertEquals(noKey.status, 503)

  const hidden = await invoke(
    (c) => syncForgeHandler(c, fakeDb({ visible: [] }), ORG, APP_ID),
    { method: 'POST' },
  )
  assertEquals(hidden.status, 404)

  const denied = await invoke(
    (c) =>
      syncForgeHandler(
        c,
        fakeDb({ visible: [{ id: APP_ID, organizationId: null }] }),
        ORG,
        APP_ID,
      ),
    { method: 'POST' },
  )
  assertEquals(denied.status, 403)

  const missing = await invoke(
    (c) =>
      syncForgeHandler(
        c,
        fakeDb({
          visible: [{ id: APP_ID, organizationId: ORG_ID }],
          appRows: [],
        }),
        ORG,
        APP_ID,
      ),
    { method: 'POST' },
  )
  assertEquals(missing.status, 404)

  const gitlab = await invoke(
    (c) =>
      syncForgeHandler(
        c,
        fakeDb({ appRows: [appRow({ provider: 'gitlab' })] }),
        ORG,
        APP_ID,
      ),
    { method: 'POST' },
  )
  assertEquals(gitlab.status, 400)
  assertEquals((await jsonOf(gitlab)).error, 'git_app_sync_unsupported')
})

test('sync reports a GitHub credential failure as 502, never as 401', async () => {
  const response = await invoke(
    (c) =>
      syncForgeHandler(
        c,
        fakeDb({ appRows: [appRow({ envelopes: {} })] }),
        ORG,
        APP_ID,
      ),
    { method: 'POST' },
  )
  assertEquals(response.status, 502)
  const body = await jsonOf(response)
  assertEquals(body.error, 'git_app_sync_failed')
  assertEquals(typeof body.detail, 'string')
})

test('sync writes GitHub metadata and keeps isPublic when GitHub omitted it', async () => {
  const pem = await pkcs8Pem()
  const sealed = await encryptSecret(await encryption(), pem)
  const db = fakeDb({
    publicUrls: ['https://panel.example.com'],
    appRows: [appRow({ envelopes: { privateKeyEnvelope: sealed }, isPublic: true })],
  })

  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          id: 99,
          name: 'Renamed on GitHub',
          slug: 'renamed',
          permissions: { contents: 'read' },
          events: ['push'],
        }),
        { status: 200 },
      ),
    async () => {
      const response = await invoke(
        (c) => syncForgeHandler(c, db, ORG, APP_ID),
        { method: 'POST' },
      )
      assertEquals(response.status, 200)
      const body = await jsonOf(response)
      const app = body.app
      if (typeof app !== 'object' || app === null) {
        throw new TypeError('expected synced app')
      }
      assertEquals((app as Record<string, unknown>).name, 'Renamed on GitHub')
      assertEquals((app as Record<string, unknown>).isPublic, true)
      const provider = body.provider
      if (typeof provider !== 'object' || provider === null) {
        throw new TypeError('expected provider snapshot')
      }
      assertEquals((provider as Record<string, unknown>).events, ['push'])
    },
  )
})

test('sync records visibility when GitHub reports it and 404s if the update vanishes', async () => {
  const pem = await pkcs8Pem()
  const sealed = await encryptSecret(await encryption(), pem)

  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          id: 99,
          name: 'Public App',
          slug: 'public-app',
          public: true,
          permissions: {},
          events: [],
        }),
        { status: 200 },
      ),
    async () => {
      const ok = await invoke(
        (c) =>
          syncForgeHandler(
            c,
            fakeDb({
              appRows: [appRow({ envelopes: { privateKeyEnvelope: sealed } })],
            }),
            ORG,
            APP_ID,
          ),
        { method: 'POST' },
      )
      assertEquals(ok.status, 200)
    },
  )

  await withFetch(
    () =>
      new Response(
        JSON.stringify({ id: 99, name: 'Gone', slug: 'gone', permissions: {}, events: [] }),
        { status: 200 },
      ),
    async () => {
      const vanished = await invoke(
        (c) =>
          syncForgeHandler(
            c,
            fakeDb({
              appRows: [appRow({ envelopes: { privateKeyEnvelope: sealed } })],
              updateEmpty: true,
            }),
            ORG,
            APP_ID,
          ),
        { method: 'POST' },
      )
      assertEquals(vanished.status, 404)
    },
  )
})

test('sync turns a GitHub network error into 502 with the thrown message', async () => {
  const pem = await pkcs8Pem()
  const sealed = await encryptSecret(await encryption(), pem)
  await withFetch(
    () => {
      throw new TypeError('upstream reset')
    },
    async () => {
      const response = await invoke(
        (c) =>
          syncForgeHandler(
            c,
            fakeDb({ appRows: [appRow({ envelopes: { privateKeyEnvelope: sealed } })] }),
            ORG,
            APP_ID,
          ),
        { method: 'POST' },
      )
      assertEquals(response.status, 502)
      const body = await jsonOf(response)
      assertEquals(body.detail, 'github app lookup failed: upstream reset')
    },
  )
})

test('start manifest requires signing, a published origin, and a valid wizard body', async () => {
  const unsigned = await invoke(
    (c) => startGithubManifestHandler(c, fakeDb({ publicUrls: ['https://panel.example.com'] }), ORG),
    { secrets: false, method: 'POST', body: { name: 'Acme Panel' } },
  )
  assertEquals(unsigned.status, 503)
  assertEquals(
    (await jsonOf(unsigned)).error,
    'Signing unavailable — no root secret configured',
  )

  const noOrigin = await invoke(
    (c) => startGithubManifestHandler(c, fakeDb(), ORG),
    { method: 'POST', body: { name: 'Acme Panel' } },
  )
  assertEquals(noOrigin.status, 503)
  assertEquals((await jsonOf(noOrigin)).error, 'public_url_not_configured')

  const invalid = await invoke(
    (c) =>
      startGithubManifestHandler(
        c,
        fakeDb({ publicUrls: ['https://panel.example.com'] }),
        ORG,
      ),
    { method: 'POST', body: { name: '' } },
  )
  assertEquals(invalid.status, 400)

  const unknownOrigin = await invoke(
    (c) =>
      startGithubManifestHandler(
        c,
        fakeDb({ publicUrls: ['https://panel.example.com'] }),
        ORG,
      ),
    {
      method: 'POST',
      body: { name: 'Acme Panel', webhookOrigin: 'https://hooks.example.com' },
    },
  )
  assertEquals(unknownOrigin.status, 400)
  assertEquals((await jsonOf(unknownOrigin)).error, 'webhook_origin_not_published')
})

test('start manifest pins the org in callback URLs and keeps the app private', async () => {
  const response = await invoke(
    (c) =>
      startGithubManifestHandler(
        c,
        fakeDb({
          publicUrls: ['https://panel.example.com', 'https://hooks.example.com'],
        }),
        ORG,
      ),
    {
      method: 'POST',
      body: {
        name: 'Acme Panel',
        organizationLogin: 'acme',
        webhookOrigin: 'https://hooks.example.com',
        pullRequestAccess: 'write',
      },
    },
  )
  assertEquals(response.status, 200)
  const body = await jsonOf(response)
  const manifest = body.manifest
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('expected manifest')
  }
  const fields = manifest as Record<string, unknown>
  assertEquals(fields.public, false)
  assertEquals(
    fields.redirect_url,
    `https://panel.example.com/api/client/v1/forges/github/manifest/callback?organizationId=${ORG_ID}`,
  )
  assertEquals(
    fields.setup_url,
    `https://panel.example.com/api/client/v1/repositories/github/callback`,
  )
  const hooks = fields.hook_attributes
  if (typeof hooks !== 'object' || hooks === null) {
    throw new TypeError('expected hook_attributes')
  }
  assertEquals((hooks as Record<string, unknown>).url, 'https://hooks.example.com/webhook/github')
  assertEquals(
    body.createUrl,
    `https://github.com/organizations/acme/settings/apps/new?state=${
      encodeURIComponent(String(body.state))
    }`,
  )
})

test('start manifest for the admin surface is public and uses the admin callback', async () => {
  const response = await invoke(
    (c) =>
      startGithubManifestHandler(
        c,
        fakeDb({ publicUrls: ['https://panel.example.com'] }),
        ADMIN,
      ),
    { method: 'POST', body: { name: 'Instance App' } },
  )
  const body = await jsonOf(response)
  const manifest = body.manifest as Record<string, unknown>
  assertEquals(manifest.public, true)
  assertEquals(
    manifest.redirect_url,
    'https://panel.example.com/api/admin/v1/forges/github/manifest/callback',
  )
  assertEquals(
    manifest.setup_url,
    'https://panel.example.com/api/client/v1/repositories/github/callback',
  )
})

async function signedState(
  claims: GithubManifestStateClaims,
): Promise<string> {
  return await signGithubManifestState(secretsConfig, claims)
}

function conversionPayload() {
  return {
    id: 4242,
    slug: 'acme-panel',
    client_id: 'Iv1.xyz',
    client_secret: 'secret',
    pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    webhook_secret: 'hook-secret',
  }
}

test('complete manifest redirects when signing, encryption, or the query is missing', async () => {
  const unsigned = await invoke(
    (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
    { secrets: false, path: 'http://tp.test/callback?state=s&code=c' },
  )
  assertEquals(unsigned.status, 302)
  assertEquals(unsigned.headers.get('location'), `/${ORG_ID}/projects/git-sources?error=unavailable`)

  const noEncrypt = await invoke(
    (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
    { encrypt: false, path: 'http://tp.test/callback?state=s&code=c' },
  )
  assertEquals(noEncrypt.headers.get('location'), `/${ORG_ID}/projects/git-sources?error=unavailable`)

  const missing = await invoke((c) => completeGithubManifestHandler(c, fakeDb(), ORG))
  assertEquals(missing.headers.get('location'), `/${ORG_ID}/projects/git-sources?error=invalid_request`)

  const badState = await invoke(
    (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
    { path: 'http://tp.test/callback?state=not-a-state&code=code' },
  )
  assertEquals(badState.headers.get('location'), `/${ORG_ID}/projects/git-sources?error=state_invalid`)
})

test('complete manifest rejects a state minted for another organization', async () => {
  const state = await signedState({
    organizationId: null,
    webhookRef: 'ref-pending',
    baseUrl: 'https://github.com',
    name: 'Acme Panel',
  })
  const response = await invoke(
    (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
    { path: `http://tp.test/callback?state=${encodeURIComponent(state)}&code=code` },
  )
  assertEquals(response.headers.get('location'), `/${ORG_ID}/projects/git-sources?error=forbidden`)
})

test('complete manifest maps conversion failure, conflict, create failure, and success', async () => {
  const state = await signedState({
    organizationId: ORG_ID,
    webhookRef: 'ref-pending',
    baseUrl: 'https://github.com',
    name: 'Acme Panel',
    webhookOrigin: 'https://hooks.example.com',
    apiUrl: null,
    isPublic: false,
    customGitUser: 'git',
    customGitPort: 2222,
  })
  const path = `http://tp.test/callback?state=${encodeURIComponent(state)}&code=one-shot`

  await withFetch(
    () => new Response('nope', { status: 422 }),
    async () => {
      const failed = await invoke(
        (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
        { path },
      )
      assertEquals(
        failed.headers.get('location'),
        `/${ORG_ID}/projects/git-sources?error=conversion_failed`,
      )
    },
  )

  await withFetch(
    () => new Response(JSON.stringify(conversionPayload()), { status: 200 }),
    async () => {
      const conflict = await invoke(
        (c) =>
          completeGithubManifestHandler(c, fakeDb({ insertError: uniqueViolation() }), ORG),
        { path },
      )
      assertEquals(
        conflict.headers.get('location'),
        `/${ORG_ID}/projects/git-sources?error=conflict`,
      )
    },
  )

  await withFetch(
    () => new Response(JSON.stringify(conversionPayload()), { status: 200 }),
    async () => {
      const created = await invoke(
        (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
        { path },
      )
      assertEquals(
        created.headers.get('location'),
        `/${ORG_ID}/projects/git-sources/${APP_ID}?created=${APP_ID}`,
      )
    },
  )
})

test('complete manifest maps a ForgeError to create_failed and rethrows other writes', async () => {
  const state = await signedState({
    organizationId: ORG_ID,
    webhookRef: 'ref-pending',
    baseUrl: 'https://github.com',
    name: 'Acme Panel',
  })
  const path = `http://tp.test/callback?state=${encodeURIComponent(state)}&code=one-shot`

  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          ...conversionPayload(),
          // Too short for the GitLab floor — but this is a github create.
          // Force ForgeError via an empty name in the signed state instead.
        }),
        { status: 200 },
      ),
    async () => {
      const emptyName = await signedState({
        organizationId: ORG_ID,
        webhookRef: 'ref-pending',
        baseUrl: 'https://github.com',
        name: '   ',
      })
      const failed = await invoke(
        (c) => completeGithubManifestHandler(c, fakeDb(), ORG),
        { path: `http://tp.test/callback?state=${encodeURIComponent(emptyName)}&code=one-shot` },
      )
      assertEquals(
        failed.headers.get('location'),
        `/${ORG_ID}/projects/git-sources?error=create_failed`,
      )
    },
  )

  await withFetch(
    () => new Response(JSON.stringify(conversionPayload()), { status: 200 }),
    async () => {
      const unexpected = await invoke(
        (c) =>
          completeGithubManifestHandler(
            c,
            fakeDb({ insertError: new TypeError('io') }),
            ORG,
          ),
        { path },
      )
      assertEquals(unexpected.status, 500)
    },
  )
})

test('complete manifest on the admin surface returns to /admin/git', async () => {
  const state = await signedState({
    organizationId: null,
    webhookRef: 'ref-pending',
    baseUrl: 'https://github.com',
    name: 'Instance App',
    isPublic: true,
  })
  await withFetch(
    () => new Response(JSON.stringify(conversionPayload()), { status: 200 }),
    async () => {
      const created = await invoke(
        (c) => completeGithubManifestHandler(c, fakeDb(), ADMIN),
        { path: `http://tp.test/callback?state=${encodeURIComponent(state)}&code=one-shot` },
      )
      assertEquals(
        created.headers.get('location'),
        `/admin/git/${APP_ID}?created=${APP_ID}`,
      )
    },
  )
})
