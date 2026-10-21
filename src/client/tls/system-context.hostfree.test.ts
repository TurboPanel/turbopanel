import { assertEquals } from '@std/assert'
import { systemRotationContext } from './system-context.ts'

const test = Deno.test.bind(Deno)

const secrets = { name: 'secrets' } as never
const encryption = { name: 'encryption' } as never

test('the sweep context answers only for the secrets it was given', () => {
  const c = systemRotationContext({ secretsConfig: secrets, dataEncryptionSecrets: encryption })
  assertEquals(c.get('secretsConfig' as never) as unknown, secrets)
  assertEquals(c.get('dataEncryptionSecrets' as never) as unknown, encryption)
  assertEquals(c.get('commandQueue' as never) as unknown, undefined)
  assertEquals(c.get('db' as never) as unknown, undefined)
})

test('missing secrets read as undefined, never null', () => {
  const c = systemRotationContext({ secretsConfig: null, dataEncryptionSecrets: null })
  assertEquals(c.get('secretsConfig' as never) as unknown, undefined)
  assertEquals(c.get('dataEncryptionSecrets' as never) as unknown, undefined)
})

test('json builds a plain response with the given status', async () => {
  const c = systemRotationContext({ secretsConfig: null, dataEncryptionSecrets: null })
  const ok = c.json({ ok: true }) as Response
  assertEquals(ok.status, 200)
  assertEquals(await ok.json(), { ok: true })
  const unavailable = c.json({ error: 'Command queue unavailable' }, 503) as Response
  assertEquals(unavailable.status, 503)
  assertEquals(unavailable.headers.get('content-type'), 'application/json')
})
