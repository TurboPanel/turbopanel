import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_ROUTING_KEY,
} from '../../../features/email/smtp/amqp-topology.ts'
import type { EmailJob, EmailQueue } from '../../../features/email/types.ts'
import { compatLogWarn } from '../../../lib/log-compat.ts'
import { AmqpConfirmPublisher } from '../amqp-confirm-publisher.ts'

export { DEFAULT_AMQP_URL } from '../amqp-default-url.ts'
export { probeAmqpBrokerReachable } from '../amqp-confirm-publisher.ts'

type DenoAmqpQueueOptions = {
  amqpUrl: string
}

class DenoAmqpQueue implements EmailQueue {
  private readonly encoder = new TextEncoder()
  private readonly publisher: AmqpConfirmPublisher

  constructor(opts: DenoAmqpQueueOptions) {
    this.publisher = new AmqpConfirmPublisher({
      amqpUrl: opts.amqpUrl,
      logScope: 'email',
      assertTopology: assertEmailAmqpTopology,
    })
  }

  async enqueue(job: EmailJob): Promise<void> {
    try {
      await this.publisher.publish(
        EMAIL_AMQP_EXCHANGE,
        EMAIL_AMQP_ROUTING_KEY,
        this.encoder.encode(JSON.stringify(job))
      )
    } catch (error) {
      compatLogWarn('email', `AMQP publish failed: ${error}`)
    }
  }

  close(): Promise<void> {
    return this.publisher.close()
  }
}

export function createDenoAmqpQueue(opts: DenoAmqpQueueOptions): EmailQueue {
  return new DenoAmqpQueue(opts)
}
