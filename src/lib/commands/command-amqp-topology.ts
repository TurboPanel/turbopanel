export const COMMAND_AMQP_EXCHANGE = 'turbopanel.commands'
export const COMMAND_AMQP_QUEUE = 'turbopanel.commands.dispatch'
export const COMMAND_AMQP_ROUTING_KEY = 'command.dispatch'
export const COMMAND_AMQP_DLX = 'turbopanel.commands.dlx'
export const COMMAND_AMQP_DLQ = 'turbopanel.commands.dispatch.dlq'

type AmqpTopologyChannel = {
  assertExchange(
    exchange: string,
    type: string,
    options?: { durable?: boolean },
  ): Promise<unknown>
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, string> },
  ): Promise<unknown>
  bindQueue(
    queue: string,
    exchange: string,
    routingKey: string,
  ): Promise<unknown>
}

export async function assertCommandAmqpTopology(
  channel: AmqpTopologyChannel,
): Promise<void> {
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
  await channel.bindQueue(
    COMMAND_AMQP_QUEUE,
    COMMAND_AMQP_EXCHANGE,
    COMMAND_AMQP_ROUTING_KEY,
  )
}
