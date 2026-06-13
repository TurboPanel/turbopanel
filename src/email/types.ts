import type { Context } from 'hono'

export type EmailJob = {
  type: 'signup-verification'
  to: string
  from: string
  verificationUrl: string
}

export interface EmailQueue {
  enqueue(job: EmailJob): Promise<void>
  close?(): Promise<void>
}

export function getEmailQueue(c: Context): EmailQueue | undefined {
  return c.get('emailQueue')
}
