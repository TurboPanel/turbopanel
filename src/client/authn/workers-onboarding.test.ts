import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { createEmailOtp } from './email-otp.ts'
import { registerAuthRoutes } from './http.ts'
import { isInstanceInstalled } from './install-state.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'
import { registerClientRoutes } from '../routes.ts'
import {
  account,
  grant,
  member,
  organization,
  team,
  teammate,
  user,
} from '../../lib/db/schema.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import type { SignupEnvOverride } from './install-state.ts'
import type { EmailJob, EmailQueue } from '../../lib/email/types.ts'

class DeliveringEmailQueue implements EmailQueue {
  async enqueue(_job: EmailJob): Promise<void> {}
}

class FailingEmailQueue implements EmailQueue {
  async enqueue(_job: EmailJob): Promise<void> {
    throw new Error('simulated enqueue failure')
  }
}

const dbUrl = getDatabaseUrl()
const TEST_SECRET = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6'

async function createAuthRouteApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: 'deno' | 'workers',
  signupEnvOverride?: SignupEnvOverride,
  signupEmailVerificationEnvOverride?: SignupEnvOverride,
  emailQueue: EmailQueue = new DeliveringEmailQueue(),
) {
  const secretsConfig = parseSecretsEnv(TEST_SECRET, undefined, runtime)
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (runtime === 'workers') {
      c.set('emailQueue', emailQueue)
    }
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, {
    secrets,
    runtime,
    signupEnvOverride,
    signupEmailVerificationEnvOverride,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return app
}

async function createClientRouteApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: 'deno' | 'workers',
  signupEnvOverride?: SignupEnvOverride,
  signupEmailVerificationEnvOverride?: SignupEnvOverride,
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
  registerClientRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride,
    signupEmailVerificationEnvOverride,
    emailFrom: 'noreply@turbopanel.local',
  })
  return app
}

async function cleanupOrg(db: ReturnType<typeof createDenoDb>, userId: string) {
  const memberRows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
  const organizationIds = memberRows
    .map((row) => row.organizationId)
    .filter((id): id is string => id != null)

  await db.delete(grant).where(eq(grant.subjectId, userId))
  await db.delete(teammate).where(eq(teammate.userId, userId))
  await db.delete(member).where(eq(member.userId, userId))

  for (const organizationId of organizationIds) {
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function cleanupUser(db: ReturnType<typeof createDenoDb>, email: string) {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
  const userId = rows[0]?.id
  if (!userId) return
  await cleanupOrg(db, userId)
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

Deno.test('Workers sign-up creates an organization for the new user', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers org sign-up test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `workers-org-signup-${crypto.randomUUID()}@example.com`
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

    const userRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
    const userId = userRows[0]?.id
    if (!userId) {
      throw new Error('expected user row after sign-up')
    }

    const memberRows = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
    if (memberRows.length !== 1 || !memberRows[0]?.organizationId) {
      throw new Error(
        `expected exactly one member row with organizationId, got ${JSON.stringify(memberRows)}`,
      )
    }

    const organizationId = memberRows[0].organizationId
    const orgRows = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    if (orgRows.length !== 1) {
      throw new Error(`expected organization row for ${organizationId}`)
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

Deno.test('Deno status reflects signup email verification env override', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Deno email verification status test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  if (!(await isInstanceInstalled(db))) {
    console.warn(
      'Skipping Deno email verification status test: instance not installed',
    )
    return
  }

  const app = await createClientRouteApp(db, 'deno', '1', '1')
  const res = await app.request(`${CLIENT_API_PREFIX}/status`)
  if (res.status !== 200) {
    const body = await res.text()
    throw new Error(`expected 200, got ${res.status}: ${body}`)
  }

  const payload = await res.json() as {
    isSignupEmailVerificationEnabled: boolean
  }
  if (payload.isSignupEmailVerificationEnabled !== true) {
    throw new Error(
      `expected email verification enabled via env override, got ${JSON.stringify(payload)}`,
    )
  }
})

Deno.test('Deno sign-up honors email verification env override', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Deno sign-up verification override test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  if (!(await isInstanceInstalled(db))) {
    console.warn(
      'Skipping Deno sign-up verification override test: instance not installed',
    )
    return
  }

  const email = `deno-verify-override-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'deno', '1', '0')

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

    const userRows = await db
      .select({ isEmailVerified: user.isEmailVerified })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
    if (userRows[0]?.isEmailVerified !== true) {
      throw new Error(
        `expected isEmailVerified=true when env override disables verification, got ${JSON.stringify(userRows[0])}`,
      )
    }
  } finally {
    await cleanupUser(db, email)
  }
})

Deno.test('Workers sign-up leaves no org residue when verification email enqueue fails', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Workers enqueue rollback test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const email = `workers-enqueue-fail-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(
    db,
    'workers',
    '1',
    '1',
    new FailingEmailQueue(),
  )

  const orgCountBefore = (await db.select({ id: organization.id }).from(organization))
    .length
  const grantCountBefore = (await db.select({ id: grant.id }).from(grant)).length

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1' }),
    })

    if (res.status !== 503) {
      const body = await res.text()
      throw new Error(`expected 503, got ${res.status}: ${body}`)
    }

    const userRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
    if (userRows.length !== 0) {
      throw new Error(`expected no user row after enqueue failure, got ${userRows.length}`)
    }

    const orgCountAfter = (await db.select({ id: organization.id }).from(organization))
      .length
    const grantCountAfter = (await db.select({ id: grant.id }).from(grant)).length

    if (orgCountAfter !== orgCountBefore) {
      throw new Error(
        `expected no new organizations after enqueue failure (before=${orgCountBefore}, after=${orgCountAfter})`,
      )
    }
    if (grantCountAfter !== grantCountBefore) {
      throw new Error(
        `expected no new grants after enqueue failure (before=${grantCountBefore}, after=${grantCountAfter})`,
      )
    }
  } finally {
    await cleanupUser(db, email)
  }
})
