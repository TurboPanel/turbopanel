/**
 * Account checks. They only ever act on users this run signs up itself, never
 * on the operator's account. Mail is read from the loopback Mailpit tunnel.
 * The panel has no self-service account delete, so each run leaves its
 * `<prefix>-*@<domain>` users behind (named, unverified-then-verified, inert).
 */
import type { Check, CheckContext, MailSink, SessionClient } from '../types.ts'
import { excerpt, fail, pass, pollUntil, skip } from './helpers.ts'

const V1 = '/client/v1'
const DOMAIN = 'example.com'

/** A fresh, policy-compliant password built at run time (never a literal). */
export function runtimePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  const body = btoa(String.fromCodePoint(...bytes)).replaceAll(/[^A-Za-z0-9]/g, 'x')
  return `${body}7!Q`
}

/** First match of `pattern` (group 1) in the newest mail to `to`. */
export async function mailToken(
  ctx: Pick<CheckContext, 'sleep'>,
  mail: MailSink,
  to: string,
  pattern: RegExp,
  skipIds: ReadonlySet<string> = new Set()
): Promise<{ token: string; id: string } | undefined> {
  return pollUntil(
    ctx,
    async () => {
      const messages = (await mail.messagesTo(to)).filter((m) => !skipIds.has(m.id))
      const first = messages[0]
      if (!first) return undefined
      const token = pattern.exec(await mail.text(first.id))?.[1]
      return token ? { token: decodeURIComponent(token), id: first.id } : undefined
    },
    20,
    3000
  )
}

const VERIFY_TOKEN = /verify-email\?token=([^&\s"'<>]+)/
const RESET_TOKEN = /auth\/reset-password\/([^?\s"'<>]+)/

interface SignedUp {
  email: string
  password: string
  notes: string[]
}

/** Sign up a run-owned user and verify it through the mailed link. */
export async function signUpVerified(
  ctx: CheckContext,
  mail: MailSink,
  session: SessionClient,
  label: string
): Promise<SignedUp> {
  const email = `${ctx.prefix}-${label}@${DOMAIN}`
  const password = runtimePassword()
  const notes: string[] = []
  const res = await session.post(`${V1}/auth/sign-up`, { body: { email, password } })
  notes.push(`sign-up ${res.status}`)
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`sign-up HTTP ${res.status} ${excerpt(res.body)}`)
  const before = await session.trySignIn({ email, password })
  notes.push(`sign-in before verify ${before}`)
  const verify = await mailToken(ctx, mail, email, VERIFY_TOKEN)
  if (!verify) throw new Error('no verify-email mail arrived within 60s')
  const ok = await session.get(`${V1}/auth/verify-email?token=${encodeURIComponent(verify.token)}`)
  const replay = await session.get(
    `${V1}/auth/verify-email?token=${encodeURIComponent(verify.token)}`
  )
  notes.push(`verify link ${ok.status}, replayed link ${replay.status}`)
  if (ok.status !== 200) throw new Error(`verify-email HTTP ${ok.status}`)
  return { email, password, notes }
}

function mailParts(ctx: CheckContext) {
  if (!ctx.mail) return undefined
  if (!ctx.session) return undefined
  return { mail: ctx.mail, session: ctx.session }
}

export const authSignup: Check = {
  rowId: 'auth-signup',
  title: 'Sign up with email and password',
  requires: ['api', 'mail'],
  safety: 'creates-objects',
  async run(ctx) {
    const parts = mailParts(ctx)
    if (!parts) return skip('needs MAILPIT_URL and an applied run')
    const weak = await parts.session().post(`${V1}/auth/sign-up`, {
      body: { email: `${ctx.prefix}-weak@${DOMAIN}`, password: 'a'.repeat(3) },
    })
    const session = parts.session()
    const user = await signUpVerified(ctx, parts.mail, session, 'signup')
    const signIn = await parts.session().trySignIn({ email: user.email, password: user.password })
    const evidence = `weak password -> ${weak.status} ${excerpt(weak.body, 80)}; ${user.notes.join(', ')}; sign-in after verify ${signIn} (user ${user.email} left behind: no account delete)`
    return weak.status === 400 && signIn === 200 ? pass(evidence) : fail(evidence)
  },
}

async function sessionStatus(client: SessionClient): Promise<number> {
  return (await client.get(`${V1}/authn/session`)).status
}

export const authPasswordChange: Check = {
  rowId: 'auth-password-change',
  title: 'Change password and reset',
  requires: ['api', 'mail'],
  safety: 'creates-objects',
  async run(ctx) {
    const parts = mailParts(ctx)
    if (!parts) return skip('needs MAILPIT_URL and an applied run')
    const user = await signUpVerified(ctx, parts.mail, parts.session(), 'pwchange')
    const a = parts.session()
    const b = parts.session()
    await a.signIn(user)
    await b.signIn(user)
    const next = runtimePassword()
    const wrong = await a.post(`${V1}/auth/change-password`, {
      body: { currentPassword: runtimePassword(), newPassword: next },
    })
    const changed = await a.post(`${V1}/auth/change-password`, {
      body: { currentPassword: user.password, newPassword: next },
    })
    const oldPw = await parts.session().trySignIn({ email: user.email, password: user.password })
    const other = await sessionStatus(b)
    const reset = await resetFlow(ctx, parts.mail, parts.session(), user.email)
    const evidence = `wrong current ${wrong.status}, change ${changed.status}, old password sign-in ${oldPw}, other session ${other}; ${reset.note}`
    const ok = wrong.status === 400 && changed.status === 200 && oldPw === 401 && other === 401
    return ok && reset.ok ? pass(evidence) : fail(evidence)
  },
}

async function resetFlow(
  ctx: CheckContext,
  mail: MailSink,
  session: SessionClient,
  email: string
): Promise<{ ok: boolean; note: string }> {
  const seen = new Set((await mail.messagesTo(email)).map((m) => m.id))
  const req = await session.post(`${V1}/auth/request-password-reset`, { body: { email } })
  const mailed = await mailToken(ctx, mail, email, RESET_TOKEN, seen)
  if (!mailed) return { ok: false, note: `reset request ${req.status}, no reset mail within 60s` }
  const fresh = runtimePassword()
  const done = await session.post(`${V1}/auth/reset-password`, {
    body: { token: mailed.token, newPassword: fresh },
  })
  const signIn = await session.trySignIn({ email, password: fresh })
  const ok = req.status === 200 && done.status === 200 && signIn === 200
  return {
    ok,
    note: `reset request ${req.status}, reset ${done.status}, sign-in with reset password ${signIn}`,
  }
}

export const AUTH_CHECKS: readonly Check[] = [authSignup, authPasswordChange]
