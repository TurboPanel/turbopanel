import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { CommandQueue } from './queue.ts'
import { getCommandQueue } from './queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getCommandQueue reads the Hono context binding', async () => {
  const queue = {
    enqueue: async () => {},
  } satisfies CommandQueue

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('commandQueue', queue)
    await next()
  })
  app.get('/probe', (c) => {
    assertEquals(getCommandQueue(c), queue)
    return c.text('ok')
  })

  const res = await app.request('http://localhost/probe')
  assertEquals(res.status, 200)
})

test('getCommandQueue returns undefined when the binding is absent', async () => {
  const app = new Hono()
  app.get('/probe', (c) => {
    assertEquals(getCommandQueue(c), undefined)
    return c.text('ok')
  })

  const res = await app.request('http://localhost/probe')
  assertEquals(res.status, 200)
})
