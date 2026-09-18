import type { Context } from 'hono'

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password'

export type EmailJob =
  | {
      type: 'signup-verification'
      to: string
      from: string
      verificationUrl: string
    }
  | {
      type: 'email-otp'
      to: string
      from: string
      otp: string
      otpType: OtpType
    }
  | {
      type: 'server-tier-notice'
      to: string
      from: string
      kind: 'exceeds' | 'overprovisioned'
      serverName: string
      organizationName: string
      licenseTierLabel: string
      requiredTierLabel: string
      recommendedTierLabel: string
      unwatched: { nics: string[]; drives: string[]; gpus: string[] }
      consoleUrl: string
    }
  | {
      type: 'invitation'
      to: string
      from: string
      inviterEmail: string
      organizationName: string
      teamName: string
      acceptUrl: string
    }
  | {
      /** One notification event delivered to an email channel (`src/lib/notifications/`). */
      type: 'notification'
      to: string
      from: string
      event: string
      severity: 'info' | 'warning' | 'critical'
      title: string
      body: string | null
      /** `key=value` lines of the non-secret context, already rendered. */
      details: string[]
      organizationName: string | null
      /** Where to look, when the event has a target the console can show. */
      consoleUrl: string | null
      at: string
    }

export interface EmailQueue {
  enqueue(job: EmailJob): Promise<void>
  close?(): Promise<void>
}

export function getEmailQueue(c: Context): EmailQueue | undefined {
  return c.get('emailQueue')
}
