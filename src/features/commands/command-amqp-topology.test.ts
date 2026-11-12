import { assertEquals } from '@std/assert'
import {
  COMMAND_AMQP_DLQ,
  COMMAND_AMQP_DLX,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_QUEUE,
  COMMAND_AMQP_ROUTING_KEY,
  COMMAND_AMQP_DELAY_TIERS_SECONDS,
  assertCommandAmqpTopology,
  commandDelayQueueName,
  commandDelayTierSeconds,
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
    ...COMMAND_AMQP_DELAY_TIERS_SECONDS.map(
      (seconds) => `queue:${commandDelayQueueName(seconds)}:true:${COMMAND_AMQP_EXCHANGE}`
    ),
  ])
})

test('delay queues expire back into the dispatch queue after their own wait', async () => {
  const declared: Array<{ queue: string; args: Record<string, string | number> | undefined }> = []
  await assertCommandAmqpTopology({
    assertExchange: async () => undefined,
    assertQueue: async (queue, options) => {
      declared.push({ queue, args: options?.arguments })
    },
    bindQueue: async () => undefined,
  })
  const tenSeconds = declared.find((entry) => entry.queue === 'turbopanel.commands.delay.10s')
  assertEquals(tenSeconds?.args, {
    'x-message-ttl': 10_000,
    'x-dead-letter-exchange': COMMAND_AMQP_EXCHANGE,
    'x-dead-letter-routing-key': COMMAND_AMQP_ROUTING_KEY,
  })
})

test('commandDelayTierSeconds rounds up to the next tier and caps at the longest', () => {
  assertEquals(commandDelayTierSeconds(1), 5)
  assertEquals(commandDelayTierSeconds(5), 5)
  assertEquals(commandDelayTierSeconds(6), 10)
  assertEquals(commandDelayTierSeconds(120), 120)
  assertEquals(commandDelayTierSeconds(3_600), 600)
})
