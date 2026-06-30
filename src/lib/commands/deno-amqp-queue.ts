import { Buffer } from 'node:buffer'
import amqplib from 'npm:amqplib'
import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_EXCHANGE,
  COMMAND_AMQP_ROUTING_KEY,
} from './command-amqp-topology.ts'
import type { CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'
import { encodeCommandEnvelope } from './envelope.ts'
import { compatLogWarn } from '../../log-compat.ts'

export const DEFAULT_AMQP_URL = 'amqp://guest:guest@localhost:19828'

type DenoAmqpCommandQueueOptions = {
  amqpUrl: string
}

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>

class DenoAmqpCommandQueue implements CommandQueue {
  private readonly encoder = new TextEncoder()
  private connection: AmqpConnection | null = null
  private channel: AmqpChannel | null = null
  private connectPromise: Promise<void> | null = null

  constructor(private readonly opts: DenoAmqpCommandQueueOptions) {}

  private async ensureConnected(): Promise<boolean> {
    if (this.channel) return true
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        this.connection = await amqplib.connect(this.opts.amqpUrl)
        this.channel = await this.connection.createConfirmChannel()
        await assertCommandAmqpTopology(this.channel)
      })().catch((error) => {
        compatLogWarn('command-queue', `AMQP connection failed: ${error}`)
        this.connection = null
        this.channel = null
      }).finally(() => {
        this.connectPromise = null
      })
    }
    await this.connectPromise
    return this.channel !== null
  }

  async enqueue(envelope: CommandEnvelope): Promise<void> {
    const connected = await this.ensureConnected()
    if (!connected || !this.channel) {
      throw new Error('Command queue unavailable')
    }
    const content = Buffer.from(this.encoder.encode(encodeCommandEnvelope(envelope)))
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel!.publish(
          COMMAND_AMQP_EXCHANGE,
          COMMAND_AMQP_ROUTING_KEY,
          content,
          { persistent: true, mandatory: true },
          (error) => {
            if (error) reject(error)
            else resolve()
          },
        )
      })
    } catch (error) {
      compatLogWarn('command-queue', `AMQP publish failed: ${error}`)
      throw error instanceof Error ? error : new Error(String(error))
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

export function createDenoAmqpCommandQueue(opts: DenoAmqpCommandQueueOptions): CommandQueue {
  return new DenoAmqpCommandQueue(opts)
}

export async function probeCommandAmqpBrokerReachable(amqpUrl: string): Promise<boolean> {
  try {
    const connection = await amqplib.connect(amqpUrl)
    await connection.close()
    return true
  } catch {
    return false
  }
}
