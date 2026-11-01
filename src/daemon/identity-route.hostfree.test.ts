import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
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
