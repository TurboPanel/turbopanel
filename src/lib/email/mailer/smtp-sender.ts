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

function smtpAuth(cfg: SmtpConfig): { user: string; pass: string } | undefined {
  return typeof cfg.user === 'string' &&
    cfg.user.length > 0 &&
    typeof cfg.pass === 'string' &&
    cfg.pass.length > 0
    ? { user: cfg.user, pass: cfg.pass }
    : undefined
}

/**
 * A config from the `smtp` provider carries its Encryption mode: TLS options
 * follow it and certificates are always verified (no `tls` override). The
 * development catcher's config carries `none`.
 */
function buildTransport(
  cfg: SmtpConfig | undefined,
  env: Record<string, string | undefined>
): Transporter {
  const auth = cfg ? smtpAuth(cfg) : undefined
  if (cfg) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      ...smtpTransportSecurityOptions(cfg.security, cfg.port),
      ...(auth && { auth }),
      ...POOL_OPTS,
    })
  }
  const port = mailpitPort(env)
  return nodemailer.createTransport({
    host: 'localhost',
    port,
    ...smtpTransportSecurityOptions('none', port),
    tls: { rejectUnauthorized: false },
    ...POOL_OPTS,
  })
}

const NO_ENCRYPTION_MESSAGE =
  'the mail server did not offer encryption (STARTTLS); check the Encryption setting, or choose None for a trusted relay'
const CERTIFICATE_MESSAGE =
  "the mail server's certificate could not be verified; check the server name and certificate"
const NOT_TLS_MESSAGE =
  'the mail server does not speak TLS on this port; check the Encryption setting and the port'

/** Node TLS codes (`originalCode` on a nodemailer socket error) for a certificate that does not verify. */
const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** Node TLS codes for a peer that is not speaking TLS (TLS against a plain port). */
const NOT_TLS_CODES: ReadonlySet<string> = new Set([
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_UNKNOWN_PROTOCOL',
  'ERR_SSL_RECORD_LAYER_FAILURE',
])

/**
 * The plain message for a send error that retrying can not fix because the
 * server can not do the TLS the setting demands, or undefined for any other
 * error. A 5xx refusal of STARTTLS, a certificate that does not verify and a
 * peer that does not speak TLS qualify. A 4xx refusal of STARTTLS (a temporary
 * condition) and a dropped connection mid-handshake stay retryable.
 *
 * nodemailer reports a failed handshake as `ESOCKET` with the Node TLS code in
 * `originalCode`, so that code (a fixed set) decides, never the message text.
 */
export function encryptionUnavailableMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const e = error as {
    code?: unknown
    originalCode?: unknown
    command?: unknown
    responseCode?: unknown
  }
  if (e.code === 'ETLS' && e.command === 'STARTTLS' && typeof e.responseCode === 'number') {
    return e.responseCode >= 500 ? NO_ENCRYPTION_MESSAGE : undefined
  }
  if (e.code !== 'ESOCKET' && e.code !== 'ETLS') return undefined
  const original = typeof e.originalCode === 'string' ? e.originalCode : ''
  if (CERTIFICATE_CODES.has(original)) return CERTIFICATE_MESSAGE
  if (NOT_TLS_CODES.has(original)) return NOT_TLS_MESSAGE
  return undefined
}

export function isEncryptionUnavailableError(error: unknown): boolean {
  return encryptionUnavailableMessage(error) !== undefined
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
      const encryptionMessage = encryptionUnavailableMessage(e)
      const errMsg = encryptionMessage ? `${encryptionMessage} (${detail})` : detail
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
