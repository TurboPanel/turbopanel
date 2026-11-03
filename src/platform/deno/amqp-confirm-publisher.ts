import amqplib from 'amqplib'
import { Buffer } from 'node:buffer'
import { compatLogWarn } from '../../lib/log-compat.ts'

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>

/** The subset of the amqplib EventEmitter surface this module uses. */
type AmqpEmitter = {
  on?: (event: string, listener: (arg?: unknown) => void) => unknown
}

export type AmqpConfirmPublisherOptions = {
  amqpUrl: string
  /** Log scope, e.g. `command-queue` or `email`. */
  logScope: string
  /** Declares the exchanges and queues this publisher writes to. */
  assertTopology: (channel: AmqpChannel) => Promise<void>
}

type PublisherSession = {
  connection: AmqpConnection
  channel: AmqpChannel | null
  lost: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One lazily opened confirm channel to RabbitMQ that survives the broker
 * going away.
 *
 * amqplib emits `error` on a connection whose socket ends unexpectedly, and an
 * `error` event with no listener is a thrown exception: it exits the whole
 * control plane. So the listeners go on before the first await on the new
 * connection, and a loss only drops the session; the next publish opens a new
 * one. A publish that was in flight when the broker went away fails, and its
 * caller sees the error.
 */
export class AmqpConfirmPublisher {
  private session: PublisherSession | null = null
  private connectPromise: Promise<PublisherSession | null> | null = null
  private closed = false

  constructor(private readonly opts: AmqpConfirmPublisherOptions) {}

  private watchForLoss(
    target: AmqpConnection | AmqpChannel,
    label: string,
    owner: PublisherSession
  ) {
    const emitter = target as AmqpEmitter
    if (typeof emitter.on !== 'function') return
    emitter.on('error', (error) => {
      this.markLost(owner, `${label} error: ${errorMessage(error)}`)
    })
    emitter.on('close', () => {
      this.markLost(owner, `${label} closed`)
    })
  }

  private markLost(owner: PublisherSession, reason: string): void {
    if (owner.lost) return
    owner.lost = true
    if (this.session === owner) this.session = null
    compatLogWarn(this.opts.logScope, `AMQP ${reason}; the next publish reconnects`)
    // Release the socket if it is still half open; errors here mean it is gone.
    void owner.connection.close().catch(() => undefined)
  }

  private async open(): Promise<PublisherSession> {
    const connection = await amqplib.connect(this.opts.amqpUrl)
    const opened: PublisherSession = { connection, channel: null, lost: false }
    // Before the first await on this connection (see the class comment).
    this.watchForLoss(connection, 'connection', opened)
    try {
      const channel = await connection.createConfirmChannel()
      opened.channel = channel
      this.watchForLoss(channel, 'channel', opened)
      await this.opts.assertTopology(channel)
    } catch (error) {
      opened.lost = true
      await connection.close().catch(() => undefined)
      throw error
    }
    return opened
  }

  /** The live session, opening one when needed; `null` when the broker is unreachable. */
  private async ensureSession(): Promise<PublisherSession | null> {
    if (this.closed) return null
    if (this.session && !this.session.lost) return this.session
    this.connectPromise ??= this.connectOnce().finally(() => {
      this.connectPromise = null
    })
    return await this.connectPromise
  }

  /** One connect attempt shared by every publish waiting on it. */
  private async connectOnce(): Promise<PublisherSession | null> {
    let opened: PublisherSession
    try {
      opened = await this.open()
    } catch (error) {
      compatLogWarn(this.opts.logScope, `AMQP connection failed: ${errorMessage(error)}`)
      return null
    }
    if (opened.lost) return null
    if (this.closed) {
      // close() landed while this was connecting: never keep it.
      opened.lost = true
      await opened.connection.close().catch(() => undefined)
      return null
    }
    this.session = opened
    return opened
  }

  /**
   * Publish one persistent message and wait for the broker's confirm.
   * Returns `false` when no connection could be opened; rejects when the
   * broker refused the message or the channel went away under it.
   */
  async publish(exchange: string, routingKey: string, content: Uint8Array): Promise<boolean> {
    const session = await this.ensureSession()
    const channel = session?.channel
    if (!session || !channel) return false
    await new Promise<void>((resolve, reject) => {
      try {
        channel.publish(
          exchange,
          routingKey,
          Buffer.from(content),
          { persistent: true, mandatory: true },
          (error: Error | null) => {
            if (error) reject(error)
            else resolve()
          }
        )
      } catch (error) {
        // A channel closed under us throws synchronously.
        this.markLost(session, `publish failed: ${errorMessage(error)}`)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return true
  }

  /** Shuts the publisher down for good; later publishes return `false`. */
  async close(): Promise<void> {
    this.closed = true
    const session = this.session
    this.session = null
    if (!session) return
    session.lost = true
    if (session.channel) await session.channel.close().catch(() => undefined)
    await session.connection.close().catch(() => undefined)
  }
}

export async function probeAmqpBrokerReachable(amqpUrl: string): Promise<boolean> {
  try {
    const connection = await amqplib.connect(amqpUrl)
    // A probe connection can still emit late; never let that exit the process.
    ;(connection as AmqpEmitter).on?.('error', () => undefined)
    await connection.close()
    return true
  } catch {
    return false
  }
}
