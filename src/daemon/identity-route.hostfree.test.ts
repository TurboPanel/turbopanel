import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { buildBinding } from '../../scripts/generate-identity-key.mjs'
import type { AppEnv } from '../app/app.ts'
import type { Db } from '../db/connection.ts'
import { verifyIdentityResponse } from '../lib/panel-identity/document.ts'
import { resolvePanelIdentityFromBinding } from '../lib/panel-identity/identity.ts'
import { fixtureBindingJson } from '../test-fixtures/panel-identity-fixture.ts'
import { registerDaemonApiRoutes } from './api-routes.ts'

const test = Deno.test.bind(Deno)

const URLS = ['https://panel.example.test', 'https://alt.example.test:8443']

function appWith(options: Parameters<typeof registerDaemonApiRoutes>[1]) {
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerDaemonApiRoutes(app, options)
  return app
}

test('identity answers 404 without a configured identity', async () => {
  const none = await appWith({}).request('/api/daemon/v1/instance/identity')
  assertEquals(none.status, 404)
  const off = await appWith({ panelIdentity: () => Promise.resolve(null) }).request(
    '/api/daemon/v1/instance/identity'
  )
  assertEquals(off.status, 404)
})

test('identity answers a public signed document with the url list and cache header', async () => {
  const identity = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  const app = appWith({
    panelIdentity: () => Promise.resolve(identity),
    identityUrls: () => Promise.resolve(URLS),
  })
  const res = await app.request('/api/daemon/v1/instance/identity')
  assertEquals(res.status, 200)
  assert(res.headers.get('Cache-Control')?.includes('max-age'))
  const body = await res.text()
  assertEquals(JSON.parse(body).urls, URLS)
  const signature = res.headers.get('X-TurboPanel-Signature')
  assert(signature)
  assertEquals((await verifyIdentityResponse(body, signature)).ok, true)
})

test('a key made by the owner script loads and serves a verifying document', async () => {
  // The exact value `pnpm identity:set` pipes to the secret binding.
  const binding = await buildBinding()
  const identity = await resolvePanelIdentityFromBinding(JSON.stringify(binding))
  assertEquals(identity?.current.kid, binding.current.kid)
  const app = appWith({
    panelIdentity: () => Promise.resolve(identity),
    identityUrls: () => Promise.resolve(URLS),
  })
  const res = await app.request('/api/daemon/v1/instance/identity')
  assertEquals(res.status, 200)
  const signature = res.headers.get('X-TurboPanel-Signature')
  assert(signature)
  assert(signature.startsWith(`${binding.current.kid}:`))
  const verified = await verifyIdentityResponse(await res.text(), signature)
  assertEquals(verified, { ok: true, currentKid: binding.current.kid })
})

test('an unreachable database answers 503 database unavailable, not an opaque 500', async () => {
  const identity = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  const app = appWith({
    panelIdentity: () => Promise.resolve(identity),
    identityUrls: () => Promise.reject(new Error('connect timeout to db.internal:5432 as tp_app')),
  })
  const res = await app.request('/api/daemon/v1/instance/identity')
  assertEquals(res.status, 503)
  const text = await res.text()
  assertEquals(JSON.parse(text), { error: 'database unavailable' })
  assertEquals(res.headers.get('X-TurboPanel-Signature'), null)
  assert(!text.includes('db.internal'))
})

test('a connection dropped mid-flight still reaches the error handler for the replay', async () => {
  const identity = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  const app = appWith({
    panelIdentity: () => Promise.resolve(identity),
    identityUrls: () =>
      Promise.reject(Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })),
  })
  let seen: unknown
  app.onError((err, c) => {
    seen = err
    return c.text('replay', 500)
  })
  const res = await app.request('/api/daemon/v1/instance/identity')
  assertEquals(res.status, 500)
  assertEquals((seen as { code?: string }).code, 'CONNECTION_CLOSED')
})
