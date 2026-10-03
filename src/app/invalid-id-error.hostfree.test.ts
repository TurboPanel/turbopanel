import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './app.ts'
import { isInvalidUuidError, registerInvalidIdErrorHandler } from './invalid-id-error.ts'

const test = Deno.test.bind(Deno)

const uuidError = () =>
  Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
    code: '22P02',
  })

function buildApp() {
  const app = new Hono<AppEnv>()
  registerInvalidIdErrorHandler(app)
  app.get('/wrapped', () => {
    // drizzle 0.45 puts the driver error on `.cause`.
    throw new Error('Failed query: select ...', { cause: uuidError() })
  })
  app.get('/other-22P02', () => {
    throw Object.assign(new Error('invalid input syntax for type integer: "x"'), {
      code: '22P02',
    })
  })
  app.get('/boom', () => {
    throw new Error('boom')
  })
  app.get('/http', () => {
    throw new HTTPException(418, { message: 'teapot' })
  })
  return app
}

test('a wrapped invalid-uuid Postgres error answers 404', async () => {
  const res = await buildApp().request('/wrapped')
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('other invalid-text errors and unknown errors still answer 500', async () => {
  const app = buildApp()
  assertEquals((await app.request('/other-22P02')).status, 500)
  assertEquals((await app.request('/boom')).status, 500)
})

test('HTTPException responses pass through', async () => {
  assertEquals((await buildApp().request('/http')).status, 418)
})

test('isInvalidUuidError rejects non-errors', () => {
  assertEquals(isInvalidUuidError(null), false)
  assertEquals(isInvalidUuidError('x'), false)
})
