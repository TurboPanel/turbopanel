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
      /** Password-reset link (better-auth `sendResetPassword`); valid for one hour. */
      type: 'password-reset'
      to: string
      from: string
      resetUrl: string
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
      /** One notification event delivered to an email channel (`src/features/notifications/`). */
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

/**
 * Longest an email provider HTTP call may take before it is abandoned. A
 * provider that never answers must fail the send, not hold the request (and
 * whatever it holds) open until the platform kills it.
 */
export const EMAIL_PROVIDER_TIMEOUT_MS = 10_000
