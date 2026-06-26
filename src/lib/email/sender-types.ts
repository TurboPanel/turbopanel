import type { EmailJob } from './types.ts'

export type MailerSendResult =
  | { success: true }
  | { success: false; error: string; permanent: boolean }

export interface MailerSender {
  sendJob(job: EmailJob): Promise<MailerSendResult>
}
