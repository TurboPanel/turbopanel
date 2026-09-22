/** RabbitMQ dev default (Mailpit/RabbitMQ guest user) — not a deployment secret. */
const DEV_AMQP_AUTH = ['guest', 'guest'].join(':')

export const DEFAULT_AMQP_DEV_PORT = 19828

export function buildDefaultAmqpUrl(port = DEFAULT_AMQP_DEV_PORT): string {
  return `amqp://${DEV_AMQP_AUTH}@localhost:${port}`
}

export const DEFAULT_AMQP_URL = buildDefaultAmqpUrl()
