import amqplib from 'amqplib'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_ROUTING_KEY,
} from './amqp-topology.ts'
import type { EmailJob, EmailQueue } from '../types.ts'
import { compatLogWarn } from '../../../log-compat.ts'

export { DEFAULT_AMQP_URL } from '../../amqp-default-url.ts'

type DenoAmqpQueueOptions = {
  amqpUrl: string
}

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>

class DenoAmqpQueue implements EmailQueue {
  private readonly encoder = new TextEncoder()
  private connection: AmqpConnection | null = null
  private channel: AmqpChannel | null = null
  private connectPromise: Promise<void> | null = null

  constructor(private readonly opts: DenoAmqpQueueOptions) {}

  private async ensureConnected(): Promise<boolean> {
    if (this.channel) return true
    this.connectPromise ??= (async () => {
      this.connection = await amqplib.connect(this.opts.amqpUrl)
      this.channel = await this.connection.createConfirmChannel()
      await assertEmailAmqpTopology(this.channel)
    })().catch((error: unknown) => {
      compatLogWarn('email', `AMQP connection failed: ${error}`)
      this.connection = null
      this.channel = null
    }).finally(() => {
      this.connectPromise = null
    })
    await this.connectPromise
    return this.channel !== null
  }

  async enqueue(job: EmailJob): Promise<void> {
    const connected = await this.ensureConnected()
    if (!connected || !this.channel) return
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel!.publish(
          EMAIL_AMQP_EXCHANGE,
          EMAIL_AMQP_ROUTING_KEY,
          this.encoder.encode(JSON.stringify(job)),
          { persistent: true, mandatory: true },
          (error: Error | null) => {
            if (error) reject(error)
            else resolve()
          },
        )
      })
    } catch (error) {
      compatLogWarn('email', `AMQP publish failed: ${error}`)
    }
  }

  async close(): Promise<void> {
    const channel = this.channel
    const connection = this.connection
    this.channel = null
    this.connection = null
    if (channel) await channel.close().catch(() => undefined)
    if (connection) await connection.close().catch(() => undefined)
  }
}

export function createDenoAmqpQueue(opts: DenoAmqpQueueOptions): EmailQueue {
  return new DenoAmqpQueue(opts)
}

export async function probeAmqpBrokerReachable(amqpUrl: string): Promise<boolean> {
  try {
    const connection = await amqplib.connect(amqpUrl)
    await connection.close()
    return true
  } catch {
    return false
  }
}
