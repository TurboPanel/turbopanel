import { EMAIL_RETRY_TIER_DELAYS_MS } from './retry-policy.ts'

export const EMAIL_AMQP_EXCHANGE = 'turbopanel.email'
export const EMAIL_AMQP_QUEUE = 'turbopanel.email.send'
export const EMAIL_AMQP_ROUTING_KEY = 'email.send'
/** Jobs that will not be retried: permanent refusals and exhausted retries. */
export const EMAIL_AMQP_DEAD_QUEUE = 'turbopanel.email.dead'

/** A delay queue per retry tier; expired messages return to the send queue's tail. */
export function emailRetryQueueName(tier: number): string {
  return `turbopanel.email.retry.${EMAIL_RETRY_TIER_DELAYS_MS[tier]! / 1000}s`
}

/** Dead letters hold sign-in codes and addresses: keep few, keep them briefly. */
const DEAD_QUEUE_MAX_LENGTH = 1000
const DEAD_QUEUE_TTL_MS = 3 * 24 * 60 * 60 * 1000

type AmqpTopologyChannel = {
  assertExchange(exchange: string, type: string, options?: { durable?: boolean }): Promise<unknown>
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, unknown> }
  ): Promise<unknown>
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>
}

export async function assertEmailAmqpTopology(channel: AmqpTopologyChannel): Promise<void> {
  await channel.assertExchange(EMAIL_AMQP_EXCHANGE, 'topic', { durable: true })
  // The send queue is declared exactly as it always was: a durable queue whose
  // arguments change is refused by the broker, so retry and dead-letter
  // handling live in queues of their own.
  await channel.assertQueue(EMAIL_AMQP_QUEUE, { durable: true })
  await channel.bindQueue(EMAIL_AMQP_QUEUE, EMAIL_AMQP_EXCHANGE, EMAIL_AMQP_ROUTING_KEY)
  await Promise.all(
    EMAIL_RETRY_TIER_DELAYS_MS.map((_, tier) =>
      channel.assertQueue(emailRetryQueueName(tier), {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': EMAIL_AMQP_EXCHANGE,
          'x-dead-letter-routing-key': EMAIL_AMQP_ROUTING_KEY,
        },
      })
    )
  )
  await channel.assertQueue(EMAIL_AMQP_DEAD_QUEUE, {
    durable: true,
    arguments: {
      'x-max-length': DEAD_QUEUE_MAX_LENGTH,
      'x-overflow': 'drop-head',
      'x-message-ttl': DEAD_QUEUE_TTL_MS,
    },
  })
}
