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
 * - Without it, `live` refuses to migrate unless
 *   `TURBOPANEL_MIGRATE_BACKUP_ACK=1` says, on purpose, that a backup was taken
 *   another way. Every other environment (testing, staging, local, CI) prints a
 *   warning and goes on.
 *
 * The environment is `CLOUDFLARE_ENV`, the same value `migrate-locked.mjs` and
 * `check-deploy-env.mjs` use.
 */
import { spawnSync } from 'node:child_process'

export const BACKUP_COMMAND_VAR = 'TURBOPANEL_MIGRATE_BACKUP_COMMAND'
export const BACKUP_ACK_VAR = 'TURBOPANEL_MIGRATE_BACKUP_ACK'
const LIVE_ENV = 'live'

/** Decide what to do before migrating: run the command, warn, or refuse. */
export function planMigrateBackup(env) {
  const command = env[BACKUP_COMMAND_VAR]?.trim() ?? ''
  if (command) return { action: 'run', command }
  const envName = env.CLOUDFLARE_ENV?.trim() ?? ''
  if (envName !== LIVE_ENV) {
    return {
      action: 'warn',
      message: `no database backup before migrating (${BACKUP_COMMAND_VAR} is not set); continuing because this is not live`,
    }
  }
  if (env[BACKUP_ACK_VAR]?.trim() === '1') {
    return {
      action: 'warn',
      message: `no backup command; continuing on live because ${BACKUP_ACK_VAR}=1 says a backup was taken another way`,
    }
  }
  return {
    action: 'refuse',
    message: `refusing to migrate live without a backup: set ${BACKUP_COMMAND_VAR}, or ${BACKUP_ACK_VAR}=1 if a backup was taken another way`,
  }
}

/** Blank out the database URL and its password so command output is safe to print. */
export function redactSecrets(text, url) {
  let out = text
  const secrets = [url]
  try {
    const password = decodeURIComponent(new URL(url).password)
    if (password) secrets.push(password, new URL(url).password)
  } catch {
    // An unparseable URL has no separable password.
  }
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join('[redacted]')
  return out
}

/**
 * Apply the plan. Returns normally to let the migration go ahead; throws an
 * Error (message already free of secrets) to stop it. `run` is injectable for
 * tests; the default runs the command in a shell with the current environment.
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} [log]
 * @param {(command: string, env: Record<string, string | undefined>) => { status: number | null, stdout?: string | null, stderr?: string | null }} [run]
 */
export function runMigrateBackup(env, log = console.log, run = defaultRun) {
  const plan = planMigrateBackup(env)
  if (plan.action === 'refuse') throw new Error(plan.message)
  if (plan.action === 'warn') {
    log(`migrate-locked: WARNING: ${plan.message}`)
    return plan
  }
  log('migrate-locked: taking the database backup…')
  const url = env.TURBOPANEL_DATABASE_URL ?? ''
  const result = run(plan.command, env)
  const output = redactSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`, url).trim()
  if (output) log(output)
  if (result.status !== 0) {
    throw new Error(`database backup failed (exit ${result.status ?? 'signal'}); not migrating`)
  }
  log('migrate-locked: database backup finished')
  return plan
}

function defaultRun(command, env) {
  return spawnSync(command, {
    shell: true,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
