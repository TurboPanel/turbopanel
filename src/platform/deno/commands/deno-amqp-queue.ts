import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_ROUTING_KEY,
} from '../../../features/commands/command-amqp-topology.ts'
import type { CommandQueue } from '../../../features/commands/queue.ts'
import type { CommandEnvelope } from '../../../features/commands/envelope.ts'
import { encodeCommandEnvelope } from '../../../features/commands/envelope.ts'
import { compatLogWarn } from '../../../lib/log-compat.ts'
import { AmqpConfirmPublisher, probeAmqpBrokerReachable } from '../amqp-confirm-publisher.ts'

export { DEFAULT_AMQP_URL } from '../amqp-default-url.ts'

type DenoAmqpCommandQueueOptions = {
  amqpUrl: string
}

class DenoAmqpCommandQueue implements CommandQueue {
  private readonly encoder = new TextEncoder()
  private readonly publisher: AmqpConfirmPublisher

  constructor(opts: DenoAmqpCommandQueueOptions) {
    this.publisher = new AmqpConfirmPublisher({
      amqpUrl: opts.amqpUrl,
      logScope: 'command-queue',
      assertTopology: assertCommandAmqpTopology,
    })
  }

  async enqueue(envelope: CommandEnvelope): Promise<void> {
    let published: boolean
    try {
      published = await this.publisher.publish(
        COMMAND_AMQP_EXCHANGE,
        COMMAND_AMQP_ROUTING_KEY,
        this.encoder.encode(encodeCommandEnvelope(envelope))
      )
    } catch (error) {
      compatLogWarn('command-queue', `AMQP publish failed: ${error}`)
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (!published) throw new Error('Command queue unavailable')
  }

  close(): Promise<void> {
    return this.publisher.close()
  }
}

export function createDenoAmqpCommandQueue(opts: DenoAmqpCommandQueueOptions): CommandQueue {
  return new DenoAmqpCommandQueue(opts)
}

export function probeCommandAmqpBrokerReachable(amqpUrl: string): Promise<boolean> {
  return probeAmqpBrokerReachable(amqpUrl)
}
