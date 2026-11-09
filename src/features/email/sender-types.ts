import type { EmailJob } from './types.ts'

export type MailerSendResult =
  | { success: true }
  | {
      success: false
      error: string
      permanent: boolean
      /** The receiving server refused the recipient address itself (a hard bounce at send). */
      recipientRejected?: boolean
    }

export interface MailerSender {
  sendJob(job: EmailJob): Promise<MailerSendResult>
}
