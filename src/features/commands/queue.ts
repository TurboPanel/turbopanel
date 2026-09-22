import type { Context } from 'hono'
import type { CommandEnvelope } from './envelope.ts'

export interface CommandQueue {
  enqueue(envelope: CommandEnvelope): Promise<void>
  close?(): Promise<void>
}

export function getCommandQueue(c: Context): CommandQueue | undefined {
  return c.get('commandQueue')
}
