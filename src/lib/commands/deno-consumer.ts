import amqplib from 'npm:amqplib'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { compatLogError, compatLogWarn } from '../../log-compat.ts'
import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_QUEUE,
} from './command-amqp-topology.ts'
import { isTransientError, processCommandEnvelope } from './consumer.ts'
import { parseCommandEnvelope } from './envelope.ts'

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>
type AmqpMessage = Parameters<Parameters<AmqpChannel['consume']>[1]>[0]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectAmqp(url: string): Promise<AmqpConnection> {
  const maxAttempts = 30
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await amqplib.connect(url)
    } catch (error) {
      if (attempt === maxAttempts) throw error
      const errMsg = error instanceof Error ? error.message : String(error)
      compatLogWarn(
        'command-consumer',
        `AMQP connect failed (attempt ${attempt}/${maxAttempts}): ${errMsg}`,
      )
      await sleep(1000)
    }
  }
  throw new Error('connectAmqp: unreachable')
}

export async function startCommandConsumer(opts: {
  db: Db
  registry: DaemonCellRegistry
  amqpUrl: string
}): Promise<{ close(): Promise<void> }> {
  const connection = await connectAmqp(opts.amqpUrl)
  const channel = await connection.createConfirmChannel()
  await assertCommandAmqpTopology(channel)
  await channel.prefetch(1)

  const { consumerTag } = await channel.consume(
    COMMAND_AMQP_QUEUE,
    (msg) => {
      void handleMessage(msg)
    },
  )

  async function handleMessage(msg: AmqpMessage): Promise<void> {
    if (!msg) return

    try {
      const envelope = parseCommandEnvelope(msg.content.toString())
      await processCommandEnvelope(opts.db, opts.registry, envelope)
      channel.ack(msg)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (isTransientError(error)) {
        compatLogWarn('command-consumer', `transient error, requeueing: ${errMsg}`)
        channel.nack(msg, false, true)
        return
      }

      compatLogError('command-consumer', `permanent error, dead-lettering: ${errMsg}`)
      channel.nack(msg, false, false)
    }
  }

  return {
    async close(): Promise<void> {
      if (consumerTag) {
        await channel.cancel(consumerTag).catch(() => undefined)
      }
      await channel.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
    },
  }
}
