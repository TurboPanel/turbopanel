import { eq } from 'drizzle-orm'
import { it } from '@std/testing/bdd'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { createEmailOtp } from './email-otp.ts'
import { registerAuthRoutes } from './http.ts'
import {
  DEFAULT_WORKSPACE_NAME,
  IS_SIGNUP_ENABLED_CONFIG_KEY,
  isInstanceInstalled,
  resolveIsSignupEnabled,
  type SignupEnvOverride,
} from './install-state.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from './secrets.ts'
import { createAuthRateLimiter } from './auth-rate-limit.ts'
import { registerClientRoutes } from '../routes.ts'
import {
  account,
  grant,
  member,
  organization,
  setting,
  team,
  teammate,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import type { EmailJob, EmailQueue } from '../../lib/email/types.ts'
import { createNoopQueue, isNoopEmailQueue } from '../../lib/email/noop-queue.ts'
import { resolveWorkersEmailQueue } from '../../lib/email/mailgun/workers-queue.ts'
import {
  SYSTEM_EMAIL_DB_KEY,
  updateEmailSettings,
} from '../../lib/settings/email-settings.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

/** Generous limiter so multi-case Workers suites do not trip the shared IP bucket. */
const testAuthRateLimiter = createAuthRateLimiter({
  defaultPolicy: { limit: 10_000, windowMs: 60_000 },
})

class DeliveringEmailQueue implements EmailQueue {
  async enqueue(_job: EmailJob): Promise<void> {}
}

class FailingEmailQueue implements EmailQueue {
  async enqueue(_job: EmailJob): Promise<void> {
    throw new Error('simulated enqueue failure')
  }
}

const dbUrl = getDatabaseUrl()

const MAILGUN_PLATFORM_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
  TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test',
  TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
} as const

const MAILPIT_PLATFORM_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
} as const

async function setSignupEnabledSetting(
  db: ReturnType<typeof createDenoDb>,
  value: '0' | '1' | null,
): Promise<void> {
  if (value === null) {
    await db.delete(setting).where(eq(setting.key, IS_SIGNUP_ENABLED_CONFIG_KEY))
    return
  }
  await db
    .insert(setting)
    .values({ key: IS_SIGNUP_ENABLED_CONFIG_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
}

async function createAuthRouteApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: 'deno' | 'workers',
  signupEnvOverride?: SignupEnvOverride,
  options?: {
    emailQueue?: EmailQueue
    platformEnv?: Record<string, string | undefined>
    dataEncryptionSecrets?: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  },
) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, runtime)
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    // Workers fail closed without an injected durable limiter; tests use the
    // process-local shared limiter so auth routes remain exercisable.
    c.set('authRateLimiter', testAuthRateLimiter)
    if (options?.platformEnv) {
      c.set('platformEnv', options.platformEnv)
    }
    if (options?.emailQueue) {
      c.set('emailQueue', options.emailQueue)
    }
    if (options?.dataEncryptionSecrets) {
      c.set('dataEncryptionSecrets', options.dataEncryptionSecrets)
    }
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, {
    secrets,
    runtime,
    signupEnvOverride,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return app
}

async function createClientRouteApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: 'deno' | 'workers',
  signupEnvOverride?: SignupEnvOverride,
  platformEnv?: Record<string, string | undefined>,
) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, runtime)
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('authRateLimiter', testAuthRateLimiter)
    if (platformEnv) {
      c.set('platformEnv', platformEnv)
    }
    return next()
  })
  registerClientRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride,
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

  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(teammate).where(eq(teammate.userId, userId))
  await db.delete(member).where(eq(member.userId, userId))

  for (const organizationId of organizationIds) {
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
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

it('Workers password sign-up succeeds on a fresh database without install', async () => {
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
      body: JSON.stringify({ email, password: 'password1!' }),
    })

    if (res.status !== 201) {
      const body = await res.text()
      throw new Error(`expected 201, got ${res.status}: ${body}`)
    }
  } finally {
    await cleanupUser(db, email)
  }
})

it('Workers sign-up creates an organization for the new user', async () => {
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
      body: JSON.stringify({ email, password: 'password1!' }),
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

    const workspaceRows = await db
      .select({ displayName: workspace.displayName })
      .from(workspace)
      .where(eq(workspace.organizationId, organizationId))
    if (workspaceRows.length !== 1) {
      throw new Error(
        `expected exactly one workspace, got ${JSON.stringify(workspaceRows)}`,
      )
    }
    if (workspaceRows[0]?.displayName !== DEFAULT_WORKSPACE_NAME) {
      throw new Error(
        `expected workspace displayName ${DEFAULT_WORKSPACE_NAME}, got ${workspaceRows[0]?.displayName}`,
      )
    }
  } finally {
    await cleanupUser(db, email)
  }
})

it('Workers OTP auto-registration succeeds without install completion', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers OTP test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `workers-otp-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'workers', '1')
  const created = await createEmailOtp(db, email, 'sign-in')
  const otp = created.status === 'created' ? created.otp : ''

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

it('Deno sign-up still requires install completion on a fresh database', async () => {
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
    body: JSON.stringify({ email, password: 'password1!' }),
  })

  if (res.status !== 403) {
    const body = await res.text()
    throw new Error(`expected 403 install gate, got ${res.status}: ${body}`)
  }
})

it('Deno status reflects email verification from resolved email settings', async () => {
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

  const app = await createClientRouteApp(db, 'deno', '1', MAILPIT_PLATFORM_ENV)
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
      `expected email verification enabled via mailpit settings, got ${JSON.stringify(payload)}`,
    )
  }
})

it('Deno sign-up auto-verifies when email delivery is not configured', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Deno sign-up auto-verify test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  if (!(await isInstanceInstalled(db))) {
    console.warn(
      'Skipping Deno sign-up auto-verify test: instance not installed',
    )
    return
  }

  const email = `deno-auto-verify-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'deno', '1')

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1!' }),
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
        `expected isEmailVerified=true when email is not configured, got ${JSON.stringify(userRows[0])}`,
      )
    }
  } finally {
    await cleanupUser(db, email)
  }
})

it('Deno sign-up rejects when verification is required but the queue is noop', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Deno noop queue sign-up test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  if (!(await isInstanceInstalled(db))) {
    console.warn(
      'Skipping Deno noop queue sign-up test: instance not installed',
    )
    return
  }

  const email = `deno-noop-queue-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'deno', '1', {
    platformEnv: MAILPIT_PLATFORM_ENV,
    emailQueue: createNoopQueue(),
  })

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1!' }),
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
      throw new Error(`expected no user row after noop queue rejection, got ${userRows.length}`)
    }
  } finally {
    await cleanupUser(db, email)
  }
})

it('Workers sign-up leaves no org residue when verification email enqueue fails', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping Workers enqueue rollback test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const email = `workers-enqueue-fail-${crypto.randomUUID()}@example.com`
  const app = await createAuthRouteApp(db, 'workers', '1', {
    platformEnv: MAILGUN_PLATFORM_ENV,
    emailQueue: new FailingEmailQueue(),
  })

  const orgCountBefore = (await db.select({ id: organization.id }).from(organization))
    .length
  const grantCountBefore = (await db.select({ id: grant.id }).from(grant)).length

  try {
    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1!' }),
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

it('resolveIsSignupEnabled: env force overrides DB; unset defaults to disabled', () => {
  if (resolveIsSignupEnabled('1', '0') !== false) {
    throw new Error('force-disable env must override DB enabled')
  }
  if (resolveIsSignupEnabled('0', '1') !== true) {
    throw new Error('force-enable env must override DB disabled')
  }
  if (resolveIsSignupEnabled('1', undefined) !== true) {
    throw new Error('DB enabled must win when env is unset')
  }
  if (resolveIsSignupEnabled(undefined, undefined, { runtime: 'workers' }) !== false) {
    throw new Error('Workers must default to disabled when DB and env are unset')
  }
  if (resolveIsSignupEnabled(undefined, undefined, { runtime: 'deno' }) !== false) {
    throw new Error('Deno must default to disabled when DB and env are unset')
  }
})

it('Workers status, sign-up, and OTP auto-registration agree when DB signup is toggled', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers signup toggle agreement test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  // No env force — panel/DB toggle must control all three surfaces.
  const statusApp = await createClientRouteApp(db, 'workers')
  const authApp = await createAuthRouteApp(db, 'workers')
  const emailOff = `workers-signup-off-${crypto.randomUUID()}@example.com`
  const emailOn = `workers-signup-on-${crypto.randomUUID()}@example.com`

  try {
    await setSignupEnabledSetting(db, '0')

    const statusOff = await statusApp.request(`${CLIENT_API_PREFIX}/status`)
    if (statusOff.status !== 200) {
      throw new Error(`expected status 200, got ${statusOff.status}`)
    }
    const offPayload = await statusOff.json() as { isSignupEnabled: boolean }
    if (offPayload.isSignupEnabled !== false) {
      throw new Error(`expected isSignupEnabled=false, got ${JSON.stringify(offPayload)}`)
    }

    const signUpOff = await authApp.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailOff, password: 'password1!' }),
    })
    if (signUpOff.status !== 403) {
      throw new Error(`expected sign-up 403 when disabled, got ${signUpOff.status}`)
    }

    const otpOff = await createEmailOtp(db, emailOff, 'sign-in')
    const otpOffCode = otpOff.status === 'created' ? otpOff.otp : ''
    const otpSignInOff = await authApp.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailOff, otp: otpOffCode }),
    })
    if (otpSignInOff.status !== 403) {
      throw new Error(
        `expected OTP auto-reg 403 when signup disabled, got ${otpSignInOff.status}`,
      )
    }

    await setSignupEnabledSetting(db, '1')

    const statusOn = await statusApp.request(`${CLIENT_API_PREFIX}/status`)
    const onPayload = await statusOn.json() as { isSignupEnabled: boolean }
    if (onPayload.isSignupEnabled !== true) {
      throw new Error(`expected isSignupEnabled=true after toggle, got ${JSON.stringify(onPayload)}`)
    }

    const signUpOn = await authApp.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailOn, password: 'password1!' }),
    })
    if (signUpOn.status !== 201) {
      throw new Error(
        `expected sign-up 201 when enabled, got ${signUpOn.status}: ${await signUpOn.text()}`,
      )
    }

    const otpEmail = `workers-otp-on-${crypto.randomUUID()}@example.com`
    const otpOn = await createEmailOtp(db, otpEmail, 'sign-in')
    const otpOnCode = otpOn.status === 'created' ? otpOn.otp : ''
    const otpSignInOn = await authApp.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: otpEmail, otp: otpOnCode }),
    })
    if (otpSignInOn.status !== 200) {
      throw new Error(
        `expected OTP auto-reg 200 when signup enabled, got ${otpSignInOn.status}: ${await otpSignInOn.text()}`,
      )
    }
    await cleanupUser(db, otpEmail)
  } finally {
    await setSignupEnabledSetting(db, null)
    await cleanupUser(db, emailOff)
    await cleanupUser(db, emailOn)
  }
})

it('Workers email queue follows DB Mailgun settings without a Worker restart', async () => {
  if (!dbUrl) {
    console.warn('Skipping Workers email settings→queue test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'workers')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const email = `workers-mailgun-signup-${crypto.randomUUID()}@example.com`

  try {
    await db.delete(setting).where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))

    const before = await resolveWorkersEmailQueue(db, {}, dataEncryptionSecrets)
    if (!isNoopEmailQueue(before)) {
      throw new Error('expected noop queue before Mailgun settings are saved')
    }

    await updateEmailSettings(
      db,
      {},
      {
        PROVIDER: 'mailgun',
        MAILGUN_API_KEY: 'key-from-admin-panel',
        MAILGUN_DOMAIN: 'mg.example.com',
        FROM: 'noreply@example.com',
      },
      dataEncryptionSecrets,
    )

    const after = await resolveWorkersEmailQueue(db, {}, dataEncryptionSecrets)
    if (isNoopEmailQueue(after)) {
      throw new Error('expected real Mailgun queue after saving email settings')
    }

    // Sign-up must use the settings-derived queue (verification required) without
    // any platformEnv Mailgun bindings — proving admin config is live.
    await setSignupEnabledSetting(db, '1')
    const app = await createAuthRouteApp(db, 'workers', undefined, {
      emailQueue: after,
      dataEncryptionSecrets,
    })

    const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password1!' }),
    })
    // Real MailgunQueue fails to reach Mailgun in tests → 503 after rollback,
    // or 201 if enqueue somehow succeeds. Either proves we are past the
    // "email not configured" noop gate.
    if (res.status === 503) {
      const body = await res.json() as { error?: string }
      if (body.error?.includes('not configured')) {
        throw new Error(
          `sign-up still treated email as unconfigured after Mailgun save: ${JSON.stringify(body)}`,
        )
      }
    } else if (res.status !== 201) {
      throw new Error(`unexpected sign-up status ${res.status}: ${await res.text()}`)
    }
  } finally {
    await setSignupEnabledSetting(db, null)
    await db.delete(setting).where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))
    await cleanupUser(db, email)
  }
})
