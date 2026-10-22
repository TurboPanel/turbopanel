/**
 * Pre-migrate database backup gate for `scripts/migrate-locked.mjs`.
 *
 * Nothing migrates the panel's database without a backup first (no wipes:
 * rollback is restore-from-backup or a fix-forward migration). The backup is a
 * command the operator supplies, because where the dump is stored belongs to
 * the host:
 *
 * - `TURBOPANEL_MIGRATE_BACKUP_COMMAND` — a shell command that takes the
 *   database URL from its environment (`TURBOPANEL_DATABASE_URL`, already set
 *   for the migration) and writes a dump. It runs before the migration; if it
 *   fails, the migration is refused. Its output is printed with the database
 *   URL and password blanked out.
 * - `TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS` (default 900) bounds the
 *   command; a hung dump is killed and the migration refused, so the deploy
 *   never sits on the migration lock forever.
 * - Without a command, only an explicit allowlist of environments (testing,
 *   staging, local, ci, or no `CLOUDFLARE_ENV` at all) prints a warning and goes
 *   on. Any other value (live, Live, production, a typo) refuses unless
 *   `TURBOPANEL_MIGRATE_BACKUP_ACK=1` says, on purpose, that a backup was taken
 *   another way.
 *
 * The guard depends on `CLOUDFLARE_ENV`, the same value `migrate-locked.mjs`
 * and `check-deploy-env.mjs` use. Unset means a local or CI run against a
 * throwaway database (the CI build migrates its own test database that way).
 */
import { spawnSync } from 'node:child_process'

export const BACKUP_COMMAND_VAR = 'TURBOPANEL_MIGRATE_BACKUP_COMMAND'
export const BACKUP_ACK_VAR = 'TURBOPANEL_MIGRATE_BACKUP_ACK'
export const BACKUP_TIMEOUT_VAR = 'TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS'
const DEFAULT_TIMEOUT_SECONDS = 900
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const WARN_ENVS = new Set(['', 'testing', 'staging', 'local', 'ci'])
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/i
const MIN_SECRET_LENGTH = 8

/** Decide what to do before migrating: run the command, warn, or refuse. */
export function planMigrateBackup(env) {
  const command = env[BACKUP_COMMAND_VAR]?.trim() ?? ''
  if (command) return { action: 'run', command }
  const envName = env.CLOUDFLARE_ENV?.trim() ?? ''
  if (WARN_ENVS.has(envName)) {
    return {
      action: 'warn',
      message: `no database backup before migrating (${BACKUP_COMMAND_VAR} is not set); continuing because this is not a deployed environment`,
    }
  }
  if (env[BACKUP_ACK_VAR]?.trim() === '1') {
    return {
      action: 'warn',
      message: `no backup command; continuing on ${envName} because ${BACKUP_ACK_VAR}=1 says a backup was taken another way`,
    }
  }
  return {
    action: 'refuse',
    message: `refusing to migrate ${envName} without a backup: set ${BACKUP_COMMAND_VAR}, or ${BACKUP_ACK_VAR}=1 if a backup was taken another way (only testing, staging, local and ci may skip it)`,
  }
}

/** Seconds the backup command may run; a bad value stops the migration. */
export function backupTimeoutSeconds(env) {
  const raw = env[BACKUP_TIMEOUT_VAR]?.trim()
  if (!raw) return DEFAULT_TIMEOUT_SECONDS
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`${BACKUP_TIMEOUT_VAR} must be a whole number of seconds, 1 or more`)
  }
  return seconds
}

/** Values to blank out: the database URL, its password, and secret-looking env values. */
function secretsIn(env) {
  const secrets = new Set()
  const url = env.TURBOPANEL_DATABASE_URL ?? ''
  if (url) secrets.add(url)
  try {
    const parsed = new URL(url)
    if (parsed.password) secrets.add(parsed.password).add(decodeURIComponent(parsed.password))
  } catch {
    // An unparseable URL has no separable password.
  }
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && (value ?? '').length >= MIN_SECRET_LENGTH) secrets.add(value)
  }
  return [...secrets].sort((a, b) => b.length - a.length)
}

/**
 * Blank out the database URL, its password and the values of env vars named
 * like TOKEN, SECRET, KEY or PASSWORD (8+ characters). Limit: a secret the
 * command reads from somewhere else, or prints transformed (encoded, split),
 * is not caught, so the command should not print secrets at all.
 */
export function redactSecrets(text, env) {
  let out = text
  for (const secret of secretsIn(env)) {
    out = out.split(secret).join('[redacted]')
  }
  return out
}

function describeFailure(result, timeoutSeconds) {
  if (result.error?.code === 'ETIMEDOUT') {
    return `backup timed out after ${timeoutSeconds}s; not migrating`
  }
  if (result.error) return `database backup failed (${result.error.message}); not migrating`
  if (result.status === null) {
    return `database backup failed (stopped by ${result.signal ?? 'a signal'}); not migrating`
  }
  return `database backup failed (exit ${result.status}); not migrating`
}

/**
 * Apply the plan. Returns normally to let the migration go ahead; throws an
 * Error (message free of secrets) to stop it. `run` is injectable for tests;
 * the default runs the command in a shell with the current environment.
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} [log]
 * @param {(command: string, env: Record<string, string | undefined>, options: { timeoutSeconds: number }) => { status: number | null, signal?: string | null, error?: { code?: string, message: string } | null, stdout?: string | null, stderr?: string | null }} [run]
 */
export function runMigrateBackup(env, log = console.log, run = defaultRun) {
  const plan = planMigrateBackup(env)
  if (plan.action === 'refuse') throw new Error(plan.message)
  if (plan.action === 'warn') {
    log(`migrate-locked: WARNING: ${plan.message}`)
    return plan
  }
  const timeoutSeconds = backupTimeoutSeconds(env)
  log('migrate-locked: taking the database backup…')
  const result = run(plan.command, env, { timeoutSeconds })
  const output = redactSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`, env).trim()
  if (output) log(output)
  if (result.error || result.status !== 0) {
    throw new Error(redactSecrets(describeFailure(result, timeoutSeconds), env))
  }
  log('migrate-locked: database backup finished')
  return plan
}

function defaultRun(command, env, { timeoutSeconds }) {
  return spawnSync(command, {
    shell: true,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutSeconds * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES,
  })
}
