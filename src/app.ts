import { Hono } from 'hono'
import type { SessionData } from './client/authn/session-store.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import type { DerivedSecretsConfig, SecretsConfig } from './client/authn/secrets.ts'
import { registerClientRoutes } from './client/routes.ts'
import { createBrowserWriteProtectionMiddleware } from './browser-write-protection.ts'
import { registerCorsMiddleware } from './cors.ts'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import type { ExecutionLogStore } from './lib/execution-logs/types.ts'
import type { ContainerLogStore } from './lib/container-logs/types.ts'
import type { Db } from './db.ts'
import type { SignupEnvOverride } from './client/authn/install-state.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import { HEALTH_PATH } from './surfaces.ts'

export type AppEnv = {
  Variables: {
    db?: Db
    emailQueue?: EmailQueue
    commandQueue?: CommandQueue
    emailFrom?: string
    baseUrl?: string
    session?: SessionData
    /** Hyperdrive or TURBOPANEL_DATABASE_URL for database status routes (Workers). */
    postgresConnectionString?: string
    daemonCellRegistry?: DaemonCellRegistry
    queryCache?: QueryCache
    /**
     * Host server-metrics store (query path). Server metrics are on by default;
     * this stays unset when no storage backend is configured for the runtime.
     */
    serverMetricsStore?: ServerMetricsStore
    /**
     * Command execution-log (transcript) store. Stays unset when no storage
     * backend is configured for the runtime — reads then report "no transcript".
     */
    executionLogStore?: ExecutionLogStore
    /**
     * Container stdout/stderr store. Container logs are **default-off**, so
     * this is normally the `DisabledContainerLogStore` no-op rather than
     * absent — callers never branch on availability.
     */
    containerLogStore?: ContainerLogStore
    /**
     * Runtime serving the request. Used by session-cookie TLS resolution to
     * decide whether `X-Forwarded-Proto` is trustworthy (Deno Caddy-over-Unix
     * trusted proxy) or must be ignored (Workers — URL-derived only). Set by
     * `createApp`; a missing value is treated as the secure URL-derived path.
     */
    runtime?: 'deno' | 'workers'
    /** Platform env bindings for settings resolution (Workers per-request; Deno process env). */
    platformEnv?: Record<string, string | undefined>
    /** AES-GCM data encryption keys (client routes encrypt only). */
    dataEncryptionSecrets?: DerivedSecretsConfig
    /** Root secret config for per-daemon recipient sealing. */
    secretsConfig?: SecretsConfig
    /**
     * Durable, globally-shared auth throttle. Injected per-runtime by the
     * entrypoints (`workers.ts` / `deno.ts`). Absent in unit tests, where auth
     * routes fall back to the process-local shared limiter.
     */
    authRateLimiter?: AuthRateLimiter
  }
}

export function createApp(
  {
    db,
    emailQueue,
    commandQueue,
    emailFrom,
    baseUrl,
    secrets,
    runtime,
    corsOrigins,
    signupEnvOverride,
    daemonCellRegistry,
    queryCache,
    serverMetricsStore,
    executionLogStore,
    containerLogStore,
    dataEncryptionSecrets,
    secretsConfig,
    authRateLimiter,
    otpVerifierSecrets,
  }: {
    db?: Db
    emailQueue?: EmailQueue
    commandQueue?: CommandQueue
    emailFrom?: string
    baseUrl?: string
    secrets?: DerivedSecretsConfig
    runtime?: 'deno' | 'workers'
    corsOrigins?: string
    signupEnvOverride: SignupEnvOverride | undefined
    daemonCellRegistry?: DaemonCellRegistry
    queryCache?: QueryCache
    serverMetricsStore?: ServerMetricsStore
    executionLogStore?: ExecutionLogStore
    containerLogStore?: ContainerLogStore
    dataEncryptionSecrets?: DerivedSecretsConfig
    secretsConfig?: SecretsConfig
    /**
     * Durable auth throttle. When set, registered as app-level middleware
     * **before** client routes so Deno Redis (and tests) see it on auth
     * handlers. Workers still wraps per-request in `workers.ts` and may leave
     * this unset on `createApp()`.
     */
    authRateLimiter?: AuthRateLimiter
    /** HMAC keyring for email OTP verifiers — forwarded to client auth routes. */
    otpVerifierSecrets?: DerivedSecretsConfig
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerCorsMiddleware(app, corsOrigins)
  // Publish the runtime before write protection and routes so session-cookie
  // TLS resolution and same-origin browser checks know whether the Deno
  // trusted-proxy path (honors X-Forwarded-Proto + Host) or the Workers
  // URL-derived path applies.
  const resolvedRuntime = runtime ?? 'workers'
  app.use('*', (c, next) => {
    c.set('runtime', resolvedRuntime)
    return next()
  })
  // Reject cross-origin credentialed writes on client/admin/install before any
  // cookie-authenticated route runs. Daemon JWT routes are outside these
  // prefixes and stay excluded. Mounted here so Deno/Workers registrations of
  // admin + install on the same app instance are covered. Passes the resolved
  // runtime so Deno proxy-style requests compare against the browser origin
  // (not the internal Unix-socket URL).
  app.use('*', createBrowserWriteProtectionMiddleware(resolvedRuntime))
  if (db) {
    app.use('*', (c, next) => {
      c.set('db', db)
      return next()
    })
  }
  if (daemonCellRegistry) {
    app.use('*', (c, next) => {
      c.set('daemonCellRegistry', daemonCellRegistry)
      return next()
    })
  }
  if (queryCache) {
    app.use('*', (c, next) => {
      c.set('queryCache', queryCache)
      return next()
    })
  }
  if (serverMetricsStore) {
    app.use('*', (c, next) => {
      c.set('serverMetricsStore', serverMetricsStore)
      return next()
    })
  }
  if (executionLogStore) {
    app.use('*', (c, next) => {
      c.set('executionLogStore', executionLogStore)
      return next()
    })
  }
  if (containerLogStore) {
    app.use('*', (c, next) => {
      c.set('containerLogStore', containerLogStore)
      return next()
    })
  }
  if (emailQueue) {
    app.use('*', (c, next) => {
      c.set('emailQueue', emailQueue)
      return next()
    })
  }
  if (commandQueue) {
    app.use('*', (c, next) => {
      c.set('commandQueue', commandQueue)
      return next()
    })
  }
  if (emailFrom || baseUrl) {
    app.use('*', (c, next) => {
      if (emailFrom) c.set('emailFrom', emailFrom)
      if (baseUrl) c.set('baseUrl', baseUrl)
      return next()
    })
  }
  if (dataEncryptionSecrets) {
    app.use('*', (c, next) => {
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
      return next()
    })
  }
  if (secretsConfig) {
    app.use('*', (c, next) => {
      c.set('secretsConfig', secretsConfig)
      return next()
    })
  }
  // Auth limiter must be set before registerClientRoutes — Deno previously
  // injected it too late (after client auth was already mounted).
  if (authRateLimiter) {
    app.use('*', (c, next) => {
      c.set('authRateLimiter', authRateLimiter)
      return next()
    })
  }
  app.get('/', (c) => c.text('TurboPanel'))
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }))
  if (secrets) {
    registerClientRoutes(app, {
      secrets,
      otpVerifierSecrets,
      runtime: runtime ?? 'workers',
      signupEnvOverride,
      emailFrom,
      baseUrl,
    })
  }
  return app
}
