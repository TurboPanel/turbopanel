import { assertEquals } from '@std/assert'
import {
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_QUEUE,
  EMAIL_AMQP_ROUTING_KEY,
  assertEmailAmqpTopology,
} from './amqp-topology.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('assertEmailAmqpTopology asserts exchange, queue, and binding', async () => {
  const calls: string[] = []
  await assertEmailAmqpTopology({
    assertExchange: async (exchange, type, options) => {
      calls.push(`exchange:${exchange}:${type}:${options?.durable}`)
    },
    assertQueue: async (queue, options) => {
      calls.push(`queue:${queue}:${options?.durable}`)
    },
    bindQueue: async (queue, exchange, routingKey) => {
      calls.push(`bind:${queue}:${exchange}:${routingKey}`)
    },
  })
  assertEquals(calls, [
    `exchange:${EMAIL_AMQP_EXCHANGE}:topic:true`,
    `queue:${EMAIL_AMQP_QUEUE}:true`,
    `bind:${EMAIL_AMQP_QUEUE}:${EMAIL_AMQP_EXCHANGE}:${EMAIL_AMQP_ROUTING_KEY}`,
  ])
})
