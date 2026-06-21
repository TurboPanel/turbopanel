import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { createEmailVerificationLinkEmail } from '../src/lib/email/templates.ts'
import {
  resolveSelfHostedMailFromAddress,
  resolveSelfHostedSmtpConfig,
  smtpConfigFromRuntimeEnv,
  smtpEnvOverrideActive,
  type SmtpConfig,
  type SmtpRuntimeEnv,
} from '../src/lib/email/smtp/smtp-resolve.ts'
import type { EmailJob } from '../src/lib/email/types.ts'
import type { Db } from './db.ts'
import { logError } from '../src/logger.ts'

const POOL_OPTS = { pool: true, maxConnections: 5, maxMessages: 100 }
const DEFAULT_FROM = 'noreply@turbopanel.local'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type MailerSendResult =
  | { success: true }
  | { success: false; error: string; permanent: boolean }

class PermanentSendError extends Error {}

function mailpitPort(): number {
  const mailpit = Deno.env.get('MAILPIT_SMTP_PORT')?.trim()
  if (mailpit) {
    const parsed = Number.parseInt(mailpit, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  const smtp = Deno.env.get('SMTP_PORT')?.trim()
  if (smtp) {
    const parsed = Number.parseInt(smtp, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 1025
}

function buildTransport(cfg: SmtpConfig | undefined): Transporter {
  if (cfg) {
    const auth =
      typeof cfg.user === 'string' &&
        cfg.user.length > 0 &&
        typeof cfg.pass === 'string' &&
        cfg.pass.length > 0
        ? { user: cfg.user, pass: cfg.pass }
        : undefined
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: false,
      ...(auth && { auth }),
      ...POOL_OPTS,
    })
  }
  return nodemailer.createTransport({
    host: 'localhost',
    port: mailpitPort(),
    secure: false,
    tls: { rejectUnauthorized: false },
    ...POOL_OPTS,
  })
}

function runtimeEnvFromDeno(): SmtpRuntimeEnv {
  return {
    SMTP_HOST: Deno.env.get('SMTP_HOST') ?? undefined,
    SMTP_PORT: Deno.env.get('SMTP_PORT') ?? undefined,
    SMTP_USER: Deno.env.get('SMTP_USER') ?? undefined,
    SMTP_PASS: Deno.env.get('SMTP_PASS') ?? undefined,
    SMTP_FROM: Deno.env.get('SMTP_FROM') ?? undefined,
    TURBOPANEL_SYSTEM_EMAIL_FROM: Deno.env.get('TURBOPANEL_SYSTEM_EMAIL_FROM') ?? undefined,
  }
}

function fromRuntimeEnv(runtimeEnv: SmtpRuntimeEnv): string {
  return runtimeEnv.TURBOPANEL_SYSTEM_EMAIL_FROM?.trim() ||
    runtimeEnv.SMTP_FROM?.trim() ||
    DEFAULT_FROM
}

function validateEmailAddress(address: string, label: string): void {
  const trimmed = address.trim()
  const addressOnly = trimmed.endsWith('>')
    ? trimmed.slice(trimmed.lastIndexOf('<') + 1, -1).trim()
    : trimmed
  if (addressOnly === '' || !EMAIL_RE.test(addressOnly)) {
    throw new PermanentSendError(`malformed ${label} address`)
  }
}

function isPermanentSmtpError(error: unknown): boolean {
  if (error instanceof PermanentSendError) return true
  if (!error || typeof error !== 'object') return false

  const maybeError = error as { responseCode?: unknown; code?: unknown; command?: unknown }
  if (typeof maybeError.responseCode === 'number' && maybeError.responseCode >= 500) {
    return true
  }

  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  const command = typeof maybeError.command === 'string' ? maybeError.command : ''
  return code === 'EENVELOPE' ||
    code === 'EAUTH' ||
    command === 'API' ||
    command === 'AUTH'
}

export class MailerSmtpSender {
  private readonly db: Db | undefined
  private transportCache: { sig: string; transport: Transporter } | null = null

  constructor(opts: { db: Db | undefined }) {
    this.db = opts.db
  }

  private smtpSignature(cfg: SmtpConfig | undefined): string {
    if (!cfg) return 'mailpit'
    return `${cfg.host}:${cfg.port}:${cfg.user ?? ''}:${cfg.pass ?? ''}`
  }

  private async resolveSmtpConfig(): Promise<SmtpConfig | undefined> {
    const runtimeEnv = runtimeEnvFromDeno()
    if (smtpEnvOverrideActive(runtimeEnv) && !smtpConfigFromRuntimeEnv(runtimeEnv)) {
      throw new PermanentSendError('invalid SMTP configuration')
    }
    if (this.db) {
      return await resolveSelfHostedSmtpConfig(this.db, runtimeEnv)
    }
    if (smtpEnvOverrideActive(runtimeEnv)) {
      const cfg = smtpConfigFromRuntimeEnv(runtimeEnv)
      if (!cfg) {
        throw new PermanentSendError('invalid SMTP configuration')
      }
      return cfg
    }
    return undefined
  }

  private async resolveFromAddress(): Promise<string> {
    const runtimeEnv = runtimeEnvFromDeno()
    if (this.db) {
      return await resolveSelfHostedMailFromAddress(this.db, runtimeEnv)
    }
    return fromRuntimeEnv(runtimeEnv)
  }

  private async transporterForCurrentSmtp(): Promise<Transporter> {
    const cfg = await this.resolveSmtpConfig()
    const sig = this.smtpSignature(cfg)
    if (this.transportCache?.sig === sig) return this.transportCache.transport
    const transport = buildTransport(cfg)
    this.transportCache = { sig, transport }
    return transport
  }

  private stripHtml(html: string): string {
    let text = this.stripTagsLinear(html)
    text = text
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
    return this.collapseWhitespace(text.trim())
  }

  private stripTagsLinear(s: string): string {
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      const open = s.indexOf('<', i)
      if (open === -1) {
        out.push(s.slice(i))
        break
      }
      out.push(s.slice(i, open))
      const close = s.indexOf('>', open + 1)
      i = close === -1 ? s.length : close + 1
    }
    return out.join('')
  }

  private collapseWhitespace(s: string): string {
    const parts: string[] = []
    let i = 0
    while (i < s.length) {
      if (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') {
        parts.push(' ')
        while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) {
          i++
        }
      } else {
        const start = i
        while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n' && s[i] !== '\r') {
          i++
        }
        parts.push(s.slice(start, i))
      }
    }
    return parts.join('')
  }

  async sendJob(job: EmailJob): Promise<MailerSendResult> {
    try {
      switch (job.type) {
        case 'signup-verification': {
          const from = await this.resolveFromAddress()
          validateEmailAddress(from, 'from')
          validateEmailAddress(job.to, 'recipient')
          const { subject, html, text } = createEmailVerificationLinkEmail(
            job.to,
            job.verificationUrl,
          )
          const transporter = await this.transporterForCurrentSmtp()
          await transporter.sendMail({
            from,
            to: job.to,
            subject,
            html,
            text: text ?? this.stripHtml(html),
          })
          return { success: true }
        }
        default:
          return {
            success: false,
            error: `unknown job type: ${(job as EmailJob).type}`,
            permanent: true,
          }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${errMsg}`)
      return { success: false, error: errMsg, permanent: isPermanentSmtpError(e) }
    }
  }
}

export function createMailerSmtpSender(opts: { db: Db | undefined }): MailerSmtpSender {
  return new MailerSmtpSender(opts)
}
