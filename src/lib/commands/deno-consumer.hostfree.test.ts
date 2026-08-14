/**
 * Host-free coverage for deno-consumer disposition / deps helpers (no AMQP).
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  applyCommandMessageDisposition,
  buildCommandConsumerDeps,
  commandMessageDisposition,
} from './deno-consumer.ts'
import { createNoopCommandQueue } from './noop-command-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildCommandConsumerDeps returns undefined when no optional deps are set', () => {
  assertEquals(buildCommandConsumerDeps({}), undefined)
})

test('buildCommandConsumerDeps wires commandQueue when present', () => {
  const commandQueue = createNoopCommandQueue()
  assertEquals(buildCommandConsumerDeps({ commandQueue }), {
    commandQueue,
    resealDeps: undefined,
    secretsConfig: undefined,
    dataEncryptionSecrets: undefined,
  })
})

test('buildCommandConsumerDeps wires resealDeps without a queue', () => {
  const resealDeps = {
    secretsConfig: { runtime: 'deno' },
    dataEncryptionSecrets: { versions: [] },
  } as never
  const deps = buildCommandConsumerDeps({ resealDeps })
  assertEquals(deps?.resealDeps, resealDeps)
  assertEquals(deps?.commandQueue, undefined)
})

test('commandMessageDisposition acks success and branches on transient vs permanent', () => {
  assertEquals(commandMessageDisposition({ ok: true }), 'ack')
  assertEquals(
    commandMessageDisposition({ ok: false, error: new Error('ECONNREFUSED') }),
    'nack_requeue',
  )
  assertEquals(
    commandMessageDisposition({ ok: false, error: new Error('invalid command envelope') }),
    'nack_dead',
  )
  assertEquals(
    commandMessageDisposition({ ok: false, error: 'data integrity failure' }),
    'nack_dead',
  )
})

test('applyCommandMessageDisposition maps dispositions to ack/nack flags', () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const msg = { content: new Uint8Array() } as never
  const channel = {
    ack: (m: unknown) => {
      calls.push({ method: 'ack', args: [m] })
    },
    nack: (m: unknown, allUpTo: boolean, requeue: boolean) => {
      calls.push({ method: 'nack', args: [m, allUpTo, requeue] })
    },
  }

  applyCommandMessageDisposition(channel, msg, 'ack')
  applyCommandMessageDisposition(channel, msg, 'nack_requeue')
  applyCommandMessageDisposition(channel, msg, 'nack_dead')

  assertEquals(calls, [
    { method: 'ack', args: [msg] },
    { method: 'nack', args: [msg, false, true] },
    { method: 'nack', args: [msg, false, false] },
  ])
})
