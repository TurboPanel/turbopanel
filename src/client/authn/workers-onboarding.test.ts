import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { createEmailOtp } from './email-otp.ts'
import { registerAuthRoutes } from './http.ts'
import { isInstanceInstalled } from './install-state.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'
import { account, user } from '../../lib/db/schema.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import type { SignupEnvOverride } from './install-state.ts'
import type { EmailJob, EmailQueue } from '../../lib/email/types.ts'

class DeliveringEmailQueue implements EmailQueue {
  async enqueue(_job: EmailJob): Promise<void> {}
}

const dbUrl = getDatabaseUrl()
const TEST_SECRET = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6'

async function createAuthRouteApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: 'deno' | 'workers',
  signupEnvOverride?: SignupEnvOverride,
) {
  const secretsConfig = parseSecretsEnv(TEST_SECRET, undefined, runtime)
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (runtime === 'workers') {
      c.set('emailQueue', new DeliveringEmailQueue())
    }
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, { secrets, runtime, signupEnvOverride })
  app.route(CLIENT_API_PREFIX, client)
  return app
}

async function cleanupUser(db: ReturnType<typeof createDenoDb>, email: string) {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
  const userId = rows[0]?.id
  if (!userId) return
  await db.delete(account).where(eq(account.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
}

Deno.test('Workers password sign-up succeeds on a fresh database without install', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers sign-up test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `workers-signup-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'workers', '1')

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1' }),
    })

    if (res.status !== 201) {
      const body = await res.text()
      throw new Error(`expected 201, got ${res.status}: ${body}`)
    }
  } finally {
    await cleanupUser(db, email)
  }
})

Deno.test('Workers OTP auto-registration succeeds without install completion', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers OTP test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `workers-otp-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'workers', '1')
  const otp = await createEmailOtp(db, email, 'sign-in')

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, otp }),
    })

    if (res.status !== 200) {
      const body = await res.text()
      throw new Error(`expected 200, got ${res.status}: ${body}`)
    }

    const payload = await res.json() as { ok: boolean; email: string | null }
    if (!payload.ok || payload.email !== email) {
      throw new Error(`unexpected session payload: ${JSON.stringify(payload)}`)
    }
  } finally {
    await cleanupUser(db, email)
  }
})

Deno.test('Deno sign-up still requires install completion on a fresh database', async () => {
  if (!dbUrl) {
    console.warn('Skipping Deno install gate test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  if (await isInstanceInstalled(db)) {
    console.warn('Skipping Deno install gate test: instance already installed')
    return
  }

  const email = `deno-signup-gate-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'deno', '1')

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1' }),
  })

  if (res.status !== 403) {
    const body = await res.text()
    throw new Error(`expected 403 install gate, got ${res.status}: ${body}`)
  }
})
