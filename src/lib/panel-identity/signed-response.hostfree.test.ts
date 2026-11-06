import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { fixtureBindingJson } from '../../test-fixtures/panel-identity-fixture.ts'
import { base64urlDecode } from '../encoding/base64url.ts'
import { httpSigningInput } from './frame-envelope.ts'
import { resolvePanelIdentityFromBinding, type PanelIdentity } from './identity.ts'
import { SIGNED_DAEMON_RESPONSE_PATHS, signDaemonResponses } from './signed-response.ts'

const test = Deno.test.bind(Deno)

async function identity(): Promise<PanelIdentity> {
  const loaded = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  assert(loaded)
  return loaded
}

function app(panelIdentity?: () => Promise<PanelIdentity | null>) {
  const daemon = new Hono()
  daemon.use('*', signDaemonResponses(panelIdentity))
  daemon.get('/jwks.json', (c) =>
    c.json({ keys: [] }, 200, { 'Cache-Control': 'public, max-age=300' })
  )
  daemon.post('/auth/session', (c) => c.json({ ok: false, error: 'Server key not found' }, 404))
  daemon.get('/metrics', (c) => c.json({ ok: true }))
  const root = new Hono()
  root.route('/api/daemon/v1', daemon)
  return root
}

async function headerVerifies(id: PanelIdentity, path: string, res: Response): Promise<boolean> {
  const header = res.headers.get('X-TurboPanel-Signature')
  if (!header) return false
  const [kid, sig] = header.split(':')
  if (kid !== id.current.kid || !sig) return false
  const body = await res.text()
  const key = await crypto.subtle.importKey(
    'raw',
    id.current.publicRaw as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify']
  )
  return await crypto.subtle.verify(
    'Ed25519',
    key,
    base64urlDecode(sig) as BufferSource,
    httpSigningInput(path, body) as BufferSource
  )
}

test('a listed path is signed over its pathname without the query, and keeps its headers', async () => {
  const id = await identity()
  const res = await app(() => Promise.resolve(id)).request(
    'http://panel.test/api/daemon/v1/jwks.json?x=1'
  )
  assertEquals(res.headers.get('Cache-Control'), 'public, max-age=300')
  assertEquals(await headerVerifies(id, '/api/daemon/v1/jwks.json', res), true)
})

test('an error body on a listed path is signed with its status', async () => {
  const id = await identity()
  const res = await app(() => Promise.resolve(id)).request(
    'http://panel.test/api/daemon/v1/auth/session',
    { method: 'POST' }
  )
  assertEquals(res.status, 404)
  assertEquals(await headerVerifies(id, '/api/daemon/v1/auth/session', res), true)
})

test('an unlisted path, or no identity key, leaves the answer unsigned and unchanged', async () => {
  const id = await identity()
  const unlisted = await app(() => Promise.resolve(id)).request(
    'http://panel.test/api/daemon/v1/metrics'
  )
  assertEquals(unlisted.headers.has('X-TurboPanel-Signature'), false)
  for (const source of [undefined, () => Promise.resolve(null)]) {
    const res = await app(source).request('http://panel.test/api/daemon/v1/jwks.json')
    assertEquals(res.headers.has('X-TurboPanel-Signature'), false)
    assertEquals(await res.json(), { keys: [] })
  }
})

test('the list covers the state-driving and sign-in routes', () => {
  for (const path of [
    '/api/daemon/v1/jwks.json',
    '/api/daemon/v1/secrets/decrypt',
    '/api/daemon/v1/auth/challenge',
    '/api/daemon/v1/auth/session',
    '/api/daemon/v1/enroll',
    '/api/daemon/v1/instance/ca',
  ]) {
    assertEquals(SIGNED_DAEMON_RESPONSE_PATHS.has(path), true, path)
  }
})
