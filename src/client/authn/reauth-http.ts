/**
 * `POST /auth/reauth` — prove who you are again so the permanent actions in
 * `step-up-actions.ts` unlock for {@link STEP_UP_WINDOW_MS}.
 *
 * Body `{ password }` or `{ code }` (authenticator code), whichever the
 * session's allowed `methods` say. Every attempt is charged to the existing
 * `reauth` rate-limit bucket before anything is checked, and the authenticator
 * path shares the sign-in lockout and replay ledger. Success only writes the
 * per-session stamp; the session itself is neither rotated nor recreated.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { verifyPassword } from '../../lib/secrets/password.ts'
import {
  AUTH_TWO_FACTOR_MAX_BODY_BYTES,
  MAX_AUTH_OTP_CHARS,
  MAX_AUTH_PASSWORD_CHARS,
} from './auth-body-limits.ts'
import { type AuthRouteOpts, enforceAuthRateLimit } from './http.ts'
import { readActiveSession, readOptionalJsonObject } from './request-context.ts'
import {
  listStepUpMethods,
  loadCredentialPasswordHash,
  STEP_UP_WINDOW_MS,
  stampStepUp,
} from './step-up.ts'
import { verifyTotpForStepUp } from './two-factor.ts'

type Proof = { method: 'password'; password: string } | { method: 'totp'; code: string }

function readProof(body: Record<string, unknown>): Proof | null {
  const { password, code } = body
  if (typeof password === 'string' && code === undefined) {
    const ok = password.length > 0 && password.length <= MAX_AUTH_PASSWORD_CHARS
    return ok ? { method: 'password', password } : null
  }
  if (typeof code === 'string' && password === undefined) {
    const ok = code.length > 0 && code.length <= MAX_AUTH_OTP_CHARS
    return ok ? { method: 'totp', code } : null
  }
  return null
}

function refused(c: Context<AppEnv>): Response {
  return c.json({ ok: false, error: 'Reauthentication failed' }, 403)
}

async function checkPassword(
  db: NonNullable<ReturnType<typeof getDb>>,
  userId: string,
  password: string
): Promise<boolean> {
  const hash = await loadCredentialPasswordHash(db, userId)
  return hash !== null && (await verifyPassword(password, hash))
}

export function registerReauthRoutes(auth: Hono<AppEnv>, opts: AuthRouteOpts): void {
  auth.post('/reauth', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }
    const session = await readActiveSession(c, opts)
    if (!session) return c.json({ ok: false, error: 'Unauthorized' }, 401)

    const bodyRead = await readOptionalJsonObject(c, AUTH_TWO_FACTOR_MAX_BODY_BYTES)
    if (!bodyRead.ok) return bodyRead.response

    // Charge the attempt before checking anything, so a stolen session cannot
    // be used to guess the password or an authenticator code.
    const limited = await enforceAuthRateLimit(c, 'reauth', session.userId, opts.runtime)
    if (limited) return limited

    const methods = await listStepUpMethods(db, session.userId)
    if (methods.includes('signin')) {
      return c.json({ ok: false, error: 'reauth_unavailable', methods }, 400)
    }
    const proof = readProof(bodyRead.body)
    if (!proof || !methods.includes(proof.method)) {
      return c.json({ ok: false, error: 'Invalid request', methods }, 400)
    }

    const verified = await verifyProof(c, session.userId, proof)
    if (verified instanceof Response) return verified
    if (!verified) return refused(c)

    await stampStepUp(db, session.sessionId, proof.method)
    return c.json({
      ok: true as const,
      expiresAt: new Date(Date.now() + STEP_UP_WINDOW_MS).toISOString(),
    })
  })
}

async function verifyProof(
  c: Context<AppEnv>,
  userId: string,
  proof: Proof
): Promise<boolean | Response> {
  const db = getDb(c)
  if (db === undefined) {
    return c.json({ ok: false, error: 'Database unavailable' }, 503)
  }
  if (proof.method === 'password') {
    return await checkPassword(db, userId, proof.password)
  }
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ ok: false, error: 'Not configured' }, 503)
  }
  const result = await verifyTotpForStepUp(db, {
    userId,
    code: proof.code,
    dataEncryptionSecrets,
  })
  if (result === 'too_many_attempts') {
    return c.json({ ok: false, error: 'Too many attempts' }, 429)
  }
  return result === 'ok'
}
