import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_ROUTING_KEY,
  commandDelayQueueName,
  commandDelayTierSeconds,
} from '../../../features/commands/command-amqp-topology.ts'
import type { CommandEnqueueOptions, CommandQueue } from '../../../features/commands/queue.ts'
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

  async enqueue(envelope: CommandEnvelope, options?: CommandEnqueueOptions): Promise<void> {
    const delaySeconds = options?.delaySeconds ?? 0
    // A delayed message waits in its tier's queue (default exchange, routed by
    // queue name) and expires back into the dispatch queue.
    const [exchange, routingKey] =
      delaySeconds > 0
        ? ['', commandDelayQueueName(commandDelayTierSeconds(delaySeconds))]
        : [COMMAND_AMQP_EXCHANGE, COMMAND_AMQP_ROUTING_KEY]
    let published: boolean
    try {
      published = await this.publisher.publish(
        exchange,
        routingKey,
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
