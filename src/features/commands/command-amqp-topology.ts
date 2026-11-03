export const COMMAND_AMQP_EXCHANGE = 'turbopanel.commands'
export const COMMAND_AMQP_QUEUE = 'turbopanel.commands.dispatch'
export const COMMAND_AMQP_ROUTING_KEY = 'command.dispatch'
export const COMMAND_AMQP_DLX = 'turbopanel.commands.dlx'
export const COMMAND_AMQP_DLQ = 'turbopanel.commands.dispatch.dlq'

/**
 * Delay tiers, in seconds, for a command put back for later (a retry, or a
 * command waiting its server's turn). RabbitMQ only expires the message at
 * the head of a queue, so each wait has its own queue; a message there
 * expires back into the dispatch queue. Covers `COMMAND_RETRY_DELAYS_SECONDS`
 * and `SERVER_BUSY_DELAY_SECONDS` (`delivery-retry.ts`).
 */
export const COMMAND_AMQP_DELAY_TIERS_SECONDS = [5, 10, 30, 120, 600] as const

export function commandDelayQueueName(seconds: number): string {
  return `turbopanel.commands.delay.${seconds}s`
}

/** The smallest tier that waits at least `delaySeconds` (the longest when none does). */
export function commandDelayTierSeconds(delaySeconds: number): number {
  const tiers = COMMAND_AMQP_DELAY_TIERS_SECONDS
  return tiers.find((tier) => tier >= delaySeconds) ?? tiers[tiers.length - 1]!
}

type AmqpTopologyChannel = {
  assertExchange(exchange: string, type: string, options?: { durable?: boolean }): Promise<unknown>
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, string | number> }
  ): Promise<unknown>
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>
}

export async function assertCommandAmqpTopology(channel: AmqpTopologyChannel): Promise<void> {
  await channel.assertExchange(COMMAND_AMQP_DLX, 'topic', { durable: true })
  await channel.assertQueue(COMMAND_AMQP_DLQ, { durable: true })
  await channel.bindQueue(COMMAND_AMQP_DLQ, COMMAND_AMQP_DLX, COMMAND_AMQP_ROUTING_KEY)

  await channel.assertExchange(COMMAND_AMQP_EXCHANGE, 'topic', { durable: true })
  await channel.assertQueue(COMMAND_AMQP_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': COMMAND_AMQP_DLX,
    },
  })
  await channel.bindQueue(COMMAND_AMQP_QUEUE, COMMAND_AMQP_EXCHANGE, COMMAND_AMQP_ROUTING_KEY)

  // Delay queues are new queues, so the arguments of the two above (which the
  // broker refuses to change on an existing durable queue) stay as they were.
  // Messages are published to them through the default exchange.
  for (const seconds of COMMAND_AMQP_DELAY_TIERS_SECONDS) {
    await channel.assertQueue(commandDelayQueueName(seconds), {
      durable: true,
      arguments: {
        'x-message-ttl': seconds * 1000,
        'x-dead-letter-exchange': COMMAND_AMQP_EXCHANGE,
        'x-dead-letter-routing-key': COMMAND_AMQP_ROUTING_KEY,
      },
    })
  }
}
