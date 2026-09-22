export const EMAIL_AMQP_EXCHANGE = 'turbopanel.email'
export const EMAIL_AMQP_QUEUE = 'turbopanel.email.send'
export const EMAIL_AMQP_ROUTING_KEY = 'email.send'

type AmqpTopologyChannel = {
  assertExchange(
    exchange: string,
    type: string,
    options?: { durable?: boolean },
  ): Promise<unknown>
  assertQueue(
    queue: string,
    options?: { durable?: boolean },
  ): Promise<unknown>
  bindQueue(
    queue: string,
    exchange: string,
    routingKey: string,
  ): Promise<unknown>
}

export async function assertEmailAmqpTopology(
  channel: AmqpTopologyChannel,
): Promise<void> {
  await channel.assertExchange(EMAIL_AMQP_EXCHANGE, 'topic', { durable: true })
  await channel.assertQueue(EMAIL_AMQP_QUEUE, { durable: true })
  await channel.bindQueue(EMAIL_AMQP_QUEUE, EMAIL_AMQP_EXCHANGE, EMAIL_AMQP_ROUTING_KEY)
}
