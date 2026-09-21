import { assertEquals } from '@std/assert'
import {
  COMMAND_AMQP_DLQ,
  COMMAND_AMQP_DLX,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_QUEUE,
  COMMAND_AMQP_ROUTING_KEY,
  assertCommandAmqpTopology,
} from './command-amqp-topology.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('assertCommandAmqpTopology wires DLX then primary dispatch topology', async () => {
  const calls: string[] = []
  await assertCommandAmqpTopology({
    assertExchange: async (exchange, type, options) => {
      calls.push(`exchange:${exchange}:${type}:${options?.durable}`)
    },
    assertQueue: async (queue, options) => {
      const dlx = options?.arguments?.['x-dead-letter-exchange'] ?? ''
      calls.push(`queue:${queue}:${options?.durable}:${dlx}`)
    },
    bindQueue: async (queue, exchange, routingKey) => {
      calls.push(`bind:${queue}:${exchange}:${routingKey}`)
    },
  })
  assertEquals(calls, [
    `exchange:${COMMAND_AMQP_DLX}:topic:true`,
    `queue:${COMMAND_AMQP_DLQ}:true:`,
    `bind:${COMMAND_AMQP_DLQ}:${COMMAND_AMQP_DLX}:${COMMAND_AMQP_ROUTING_KEY}`,
    `exchange:${COMMAND_AMQP_EXCHANGE}:topic:true`,
    `queue:${COMMAND_AMQP_QUEUE}:true:${COMMAND_AMQP_DLX}`,
    `bind:${COMMAND_AMQP_QUEUE}:${COMMAND_AMQP_EXCHANGE}:${COMMAND_AMQP_ROUTING_KEY}`,
  ])
})
