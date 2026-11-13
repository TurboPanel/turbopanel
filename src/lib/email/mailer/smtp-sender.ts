import nodemailer from 'nodemailer'
import { resolveEmailTemplate } from '../../../features/email/templates.ts'
import {
  resolveEmailSettings,
  type ResolvedEmailSettings,
} from '../../../features/settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../../secrets/secrets.ts'
import type { EmailJob } from '../../../features/email/types.ts'
import type { MailerSendResult } from '../../../features/email/sender-types.ts'
import {
  PermanentSendError,
  validateEmailAddress,
} from '../../../features/email/validate-address.ts'
import type { Db } from '../../../db/connection.ts'
import { logError } from '../../logger.ts'
import {
  DEFAULT_MAILPIT_SMTP_PORT,
  normalizeMailpitSmtpEnv,
} from '../../../features/email/mailpit/env.ts'
import type { SmtpConfig } from '../../../features/email/smtp/smtp-resolve.ts'
import { smtpTransportSecurityOptions } from '../../../features/email/smtp/smtp-security.ts'

type Transporter = ReturnType<typeof nodemailer.createTransport>

const POOL_OPTS = { pool: true, maxConnections: 5, maxMessages: 100 }

export type { MailerSendResult }

function mailpitPort(env: Record<string, string | undefined>): number {
  const normalized = normalizeMailpitSmtpEnv(env)
  const mailpit = normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT?.trim()
  if (mailpit) {
    const parsed = Number.parseInt(mailpit, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  const smtp = env.SMTP_PORT?.trim() ?? env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT?.trim()
  if (smtp) {
    const parsed = Number.parseInt(smtp, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return DEFAULT_MAILPIT_SMTP_PORT
}

const SMTP_SETTING_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] as const

function smtpConfigAttempted(resolved: ResolvedEmailSettings): boolean {
  for (const key of SMTP_SETTING_KEYS) {
    const meta = resolved.keys[key]
    if (meta.isEnvOverridden || meta.isDbSet) return true
  }
  return resolved.keys.SMTP_HOST.value.trim() !== '' || resolved.keys.SMTP_PORT.value.trim() !== ''
}

function validateResolvedSmtpConfig(resolved: ResolvedEmailSettings): SmtpConfig | undefined {
  if (resolved.provider === 'mailpit-smtp') {
    if (!resolved.smtp) {
      throw new PermanentSendError('invalid Mailpit SMTP configuration')
    }
    return resolved.smtp
  }
  if (resolved.provider !== 'smtp') {
    throw new PermanentSendError(`email provider is ${resolved.provider}, not smtp`)
  }

  if (smtpConfigAttempted(resolved) && !resolved.smtp) {
    throw new PermanentSendError('invalid SMTP configuration')
  }

  return resolved.smtp
}

/**
 * Nodemailer options for a configured SMTP server. A config with a `security`
 * mode (the `smtp` provider) gets that mode's TLS options and always verifies
 * certificates (no `tls` override). A config without one (the co-located
 * Mailpit catcher) keeps the plain, opportunistic legacy options.
 */
export function buildSmtpTransportOptions(cfg: SmtpConfig): Record<string, unknown> {
  const auth =
    typeof cfg.user === 'string' &&
    cfg.user.length > 0 &&
    typeof cfg.pass === 'string' &&
    cfg.pass.length > 0
      ? { user: cfg.user, pass: cfg.pass }
      : undefined
  return {
    host: cfg.host,
    port: cfg.port,
    ...smtpTransportSecurityOptions(cfg.security, cfg.port),
    ...(auth && { auth }),
    ...POOL_OPTS,
  }
}

function buildTransport(
  cfg: SmtpConfig | undefined,
  env: Record<string, string | undefined>
): Transporter {
  if (cfg) return nodemailer.createTransport(buildSmtpTransportOptions(cfg))
  return nodemailer.createTransport({
    host: 'localhost',
    port: mailpitPort(env),
    secure: false,
    tls: { rejectUnauthorized: false },
    ...POOL_OPTS,
  })
}

const NO_ENCRYPTION_MESSAGE =
  'the mail server did not offer encryption (STARTTLS) or the TLS connection failed; check the Encryption setting and the server certificate'

/** TLS failures that a retry can not fix: wrong protocol for the port or a certificate that does not verify. */
const TLS_CONFIG_FAILURE =
  /wrong version number|packet length too long|unknown protocol|certificate|altnames|self[- ]signed/i

/**
 * True when the server refused or could not do the TLS the setting demands, so
 * trying again can not help. A 4xx refusal of STARTTLS (a temporary condition)
 * and a dropped connection mid-handshake stay retryable.
 */
export function isEncryptionUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as {
    code?: unknown
    command?: unknown
    responseCode?: unknown
    message?: unknown
  }
  if (e.code !== 'ETLS') return false
  if (e.command === 'STARTTLS' && typeof e.responseCode === 'number') {
    return e.responseCode >= 500
  }
  return typeof e.message === 'string' && TLS_CONFIG_FAILURE.test(e.message)
}

/**
 * Enhanced status codes (RFC 3463) that say the recipient address itself is
 * dead: unknown mailbox (5.1.1), unknown domain (5.1.2), bad mailbox syntax
 * (5.1.3), mailbox moved (5.1.6), domain takes no mail (5.1.10). The other
 * 5.1.x codes are about the sender address or are not specific.
 */
const DEAD_RECIPIENT_STATUS = new Set(['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10'])

/** The enhanced status code at the start of each line of an SMTP reply ("550 5.1.1 …", "550-5.1.1 …"). */
function enhancedStatusCodes(response: string): string[] {
  const codes: string[] = []
  for (const line of response.split('\n')) {
    const match = /^\d{3}[ -](\d\.\d{1,3}\.\d{1,3})(?:\s|$)/.exec(line.trim())
    if (match?.[1]) codes.push(match[1])
  }
  return codes
}

/**
 * True when the receiving server refused the recipient because the address is
 * dead: `RCPT TO` answered 550, 551 or 553 with an enhanced status code that
 * says so. A policy or relay refusal (5.7.x, "relaying denied") arrives with
 * the same 550 and says nothing about the address, and neither does a bare
 * 550 with no enhanced code: a misconfigured relay must never put every
 * recipient on the suppression list.
 */
export function isRecipientRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { responseCode?: unknown; command?: unknown; response?: unknown }
  if (e.command !== 'RCPT TO') return false
  if (e.responseCode !== 550 && e.responseCode !== 551 && e.responseCode !== 553) return false
  if (typeof e.response !== 'string') return false
  const codes = enhancedStatusCodes(e.response)
  return codes.length > 0 && codes.every((code) => DEAD_RECIPIENT_STATUS.has(code))
}

function isPermanentSmtpError(error: unknown): boolean {
  if (error instanceof PermanentSendError) return true
  if (isEncryptionUnavailableError(error)) return true
  if (!error || typeof error !== 'object') return false

  const maybeError = error as { responseCode?: unknown; code?: unknown; command?: unknown }
  if (typeof maybeError.responseCode === 'number' && maybeError.responseCode >= 500) {
    return true
  }

  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  const command = typeof maybeError.command === 'string' ? maybeError.command : ''
  return code === 'EENVELOPE' || code === 'EAUTH' || command === 'API' || command === 'AUTH'
}

export class MailerSmtpSender {
  private readonly db: Db | undefined
  private readonly env: Record<string, string | undefined>
  private readonly dataEncryptionSecrets: DerivedSecretsConfig | undefined
  private transportCache: { sig: string; transport: Transporter } | null = null

  constructor(opts: {
    db: Db | undefined
    env?: Record<string, string | undefined>
    dataEncryptionSecrets?: DerivedSecretsConfig
  }) {
    this.db = opts.db
    this.env = opts.env ?? Deno.env.toObject()
    this.dataEncryptionSecrets = opts.dataEncryptionSecrets
  }

  private smtpSignature(cfg: SmtpConfig | undefined): string {
    if (!cfg) return 'mailpit'
    return `${cfg.host}:${cfg.port}:${cfg.security ?? ''}:${cfg.user ?? ''}:${cfg.pass ?? ''}`
  }

  private async resolveEmailConfig(): Promise<Awaited<ReturnType<typeof resolveEmailSettings>>> {
    return await resolveEmailSettings(this.db, this.env, this.dataEncryptionSecrets)
  }

  private async resolveSmtpConfig(): Promise<SmtpConfig | undefined> {
    const resolved = await this.resolveEmailConfig()
    return validateResolvedSmtpConfig(resolved)
  }

  private async resolveFromAddress(): Promise<string> {
    const resolved = await this.resolveEmailConfig()
    return resolved.from
  }

  private async transporterForCurrentSmtp(): Promise<Transporter> {
    const cfg = await this.resolveSmtpConfig()
    const sig = this.smtpSignature(cfg)
    if (this.transportCache?.sig === sig) return this.transportCache.transport
    const transport = buildTransport(cfg, this.env)
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
      const template = resolveEmailTemplate(job)
      if (!template) {
        return {
          success: false,
          error: `unknown job type: ${(job as EmailJob).type}`,
          permanent: true,
        }
      }
      const from = await this.resolveFromAddress()
      validateEmailAddress(from, 'from')
      validateEmailAddress(job.to, 'recipient')
      const transporter = await this.transporterForCurrentSmtp()
      await transporter.sendMail({
        from,
        to: job.to,
        subject: template.subject,
        html: template.html,
        text: template.text ?? this.stripHtml(template.html),
        ...(template.headers ? { headers: template.headers } : {}),
      })
      return { success: true }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${detail}`)
      const noEncryption = isEncryptionUnavailableError(e)
      const errMsg = noEncryption ? `${NO_ENCRYPTION_MESSAGE} (${detail})` : detail
      return {
        success: false,
        error: errMsg,
        permanent: isPermanentSmtpError(e),
        recipientRejected: isRecipientRejected(e),
      }
    }
  }
}

export function createMailerSmtpSender(opts: {
  db: Db | undefined
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerSmtpSender {
  return new MailerSmtpSender(opts)
}
