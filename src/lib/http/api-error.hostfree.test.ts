import { assertEquals, assertThrows } from '@std/assert'
import { Hono } from 'hono'
import { ApiError, apiError, apiErrorBody } from './api-error.ts'
import { API_ERROR_CODES, isApiErrorCode } from './error-codes.ts'
import { apiErrorSchema } from './error-schema.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('apiErrorBody carries ok, error, code and message', () => {
  assertEquals(apiErrorBody('not_found', 'Server not found'), {
    ok: false,
    error: 'Server not found',
    code: 'not_found',
    message: 'Server not found',
  })
})

test('without text, error is the code and message is the registry text', () => {
  assertEquals(apiErrorBody('database_unavailable'), {
    ok: false,
    error: 'database_unavailable',
    code: 'database_unavailable',
    message: 'Database unavailable',
  })
})

test('details are included only when given', () => {
  assertEquals('details' in apiErrorBody('conflict'), false)
  assertEquals(apiErrorBody('conflict', undefined, [1]).details, [1])
})

test('apiError answers the caller status, the body and extra headers', async () => {
  const app = new Hono()
  app.get('/x', (c) =>
    apiError(c, 429, 'rate_limited', undefined, undefined, { 'Retry-After': '9' })
  )
  const res = await app.request('/x')
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After'), '9')
  assertEquals((await res.json()).code, 'rate_limited')
})

test('ApiError keeps its parts', () => {
  const err = assertThrows(
    () => {
      throw new ApiError(400, 'invalid_request', 'Bad name', { field: 'name' })
    },
    ApiError,
    'Bad name'
  )
  assertEquals([err.status, err.code, err.details], [400, 'invalid_request', { field: 'name' }])
})

test('the registry holds snake_case codes with non-empty messages', () => {
  for (const [code, message] of Object.entries(API_ERROR_CODES)) {
    assertEquals(/^[a-z][a-z0-9_]*$/.test(code), true, code)
    assertEquals(message.length > 0, true, code)
  }
  assertEquals(isApiErrorCode('not_found'), true)
  assertEquals(isApiErrorCode('toString'), false)
  assertEquals(isApiErrorCode(7), false)
})

test('the OpenAPI schema lists exactly the registry codes', () => {
  assertEquals(apiErrorSchema.properties.code.enum, Object.keys(API_ERROR_CODES))
})
