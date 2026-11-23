import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './app.ts'
import { ApiError } from '../lib/http/api-error.ts'
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
    throw new HTTPException(418, { res: new Response('teapot', { status: 418 }) })
  })
  app.get('/http-bare', () => {
    throw new HTTPException(403, { message: 'nope' })
  })
  app.get('/api/typed', () => {
    throw new ApiError(409, 'conflict', 'Name taken', { field: 'name' })
  })
  app.get('/api/typed-bare', () => {
    throw new ApiError(404, 'not_found')
  })
  return app
}

test('a wrapped invalid-uuid Postgres error answers 404', async () => {
  const res = await buildApp().request('/wrapped')
  assertEquals(res.status, 404)
  assertEquals(await res.json(), {
    ok: false,
    error: 'Not found',
    code: 'not_found',
    message: 'Not found',
  })
})

test('other invalid-text errors and unknown errors still answer 500', async () => {
  const app = buildApp()
  assertEquals((await app.request('/other-22P02')).status, 500)
  assertEquals((await app.request('/boom')).status, 500)
})

test('an HTTPException that carries its own response passes through', async () => {
  const res = await buildApp().request('/http')
  assertEquals(res.status, 418)
  assertEquals(await res.text(), 'teapot')
})

test('an HTTPException without a response answers in the envelope', async () => {
  const res = await buildApp().request('/http-bare')
  assertEquals(res.status, 403)
  assertEquals(await res.json(), {
    ok: false,
    error: 'nope',
    code: 'forbidden',
    message: 'nope',
  })
})

test('an ApiError answers its status, code, message and details', async () => {
  const res = await buildApp().request('/api/typed')
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    ok: false,
    error: 'Name taken',
    code: 'conflict',
    message: 'Name taken',
    details: { field: 'name' },
  })
})

test('an ApiError without text falls back to the code and the registry message', async () => {
  const res = await buildApp().request('/api/typed-bare')
  assertEquals(res.status, 404)
  assertEquals(await res.json(), {
    ok: false,
    error: 'not_found',
    code: 'not_found',
    message: 'Not found',
  })
})

test('an unhandled error answers a JSON 500 that does not leak the error text', async () => {
  const res = await buildApp().request('/boom')
  assertEquals(res.status, 500)
  assertEquals(res.headers.get('content-type')?.startsWith('application/json'), true)
  assertEquals(await res.json(), {
    ok: false,
    error: 'internal_error',
    code: 'internal_error',
    message: 'Internal Server Error',
  })
})

test('an unmatched /api path answers a JSON 404; other paths keep the plain 404', async () => {
  const app = buildApp()
  const api = await app.request('/api/client/v1/nothing-here')
  assertEquals(api.status, 404)
  assertEquals((await api.json()).code, 'not_found')
  const other = await app.request('/nothing-here')
  assertEquals(other.status, 404)
  assertEquals(await other.text(), '404 Not Found')
})

test('isInvalidUuidError rejects non-errors', () => {
  assertEquals(isInvalidUuidError(null), false)
  assertEquals(isInvalidUuidError('x'), false)
})
