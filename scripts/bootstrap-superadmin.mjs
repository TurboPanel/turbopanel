#!/usr/bin/env node
/**
 * Promote the first superadmin on a database that has none.
 *
 * Why this exists: the self-hosted install wizard creates the first
 * superadmin from host PAM, but the hosted (Workers) control plane has no
 * wizard — signup is off unless `TURBOPANEL_IS_SIGNUP_ENABLED` says
 * otherwise, and no route ever writes `user.role`. So a freshly migrated
 * hosted database has no way in, and the tier catalogue
 * (website `docs/deployment/tier-catalogue.mdx`) needs a superadmin to enter
 * it. This is the one-time step that closes that gap.
 *
 * It is deliberately narrow:
 *
 *   - it refuses when the database already has any superadmin, so it cannot
 *     quietly hand out a second one or be re-run by mistake;
 *   - it promotes an existing account only — it never creates a user, never
 *     sets a password, and never touches anything else;
 *   - with `CLOUDFLARE_ENV` set it runs the same origin check `pnpm migrate`
 *     does (`scripts/check-deploy-env.mjs`), so it cannot promote someone on
 *     the wrong environment's database;
 *   - `--dry-run` reports what it would do and writes nothing.
 *
 * Usage:
 *   TURBOPANEL_DATABASE_URL=… node scripts/bootstrap-superadmin.mjs --email you@example.com [--dry-run]
 *   CLOUDFLARE_ENV=live TURBOPANEL_DATABASE_URL=… pnpm bootstrap:superadmin -- --email you@example.com
 *
 * If the account does not exist yet: enable signup on that environment
 * (`TURBOPANEL_IS_SIGNUP_ENABLED=1`), sign up as that address, then run this
 * again and turn signup back off.
 */
import postgres from 'postgres'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'
import { assertMigrateTargetMatchesEnv } from './check-deploy-env.mjs'

const SUPERADMIN_ROLE = 'superadmin'

function fail(message) {
  console.error(`bootstrap-superadmin: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const emailIndex = args.indexOf('--email')
const rawEmail = emailIndex === -1 ? undefined : args[emailIndex + 1]
if (!rawEmail) {
  fail('--email <address> is required')
}
// The same normalization every sign-in path uses (client/authn/http.ts).
const email = rawEmail.trim().toLowerCase()

const url = process.env.TURBOPANEL_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
if (!url) {
  fail('TURBOPANEL_DATABASE_URL is required')
}

// With CLOUDFLARE_ENV set, refuse a database that is not that environment's
// Hyperdrive origin — the same guard pnpm migrate runs. Skipped when unset.
try {
  console.log(`bootstrap-superadmin: ${await assertMigrateTargetMatchesEnv()}`)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

const parts = resolvePostgresParts(url)
if (!parts) {
  fail('invalid TURBOPANEL_DATABASE_URL')
}
const options = { max: 1, prepare: false, onnotice: () => {} }
const client = parts.socketDir
  ? postgres({
      host: parts.socketDir,
      database: parts.database,
      user: parts.user,
      pass: parts.pass,
      ...options,
    })
  : postgres(parts.tcpUrl ?? url, options)

try {
  const existing = await client`
    select email from "user" where role = ${SUPERADMIN_ROLE} order by created_at limit 5
  `
  if (existing.length > 0) {
    fail(
      `this database already has ${existing.length === 5 ? '5 or more' : existing.length} superadmin(s) (${
        existing.map((row) => row.email).join(', ')
      }) — promote further accounts from the console, not from here`,
    )
  }

  const [target] = await client`
    select id, email, role from "user" where lower(email) = ${email} limit 1
  `
  if (!target) {
    console.error(`bootstrap-superadmin: no account with email ${email} on this database.`)
    console.error('bootstrap-superadmin: create it first —')
    console.error('  1. set TURBOPANEL_IS_SIGNUP_ENABLED=1 on this environment')
    console.error(`  2. sign up as ${email}`)
    console.error('  3. run this again, then turn signup back off')
    process.exit(2)
  }

  if (dryRun) {
    console.log(
      `bootstrap-superadmin: would promote ${target.email} (${target.id}) from ${target.role} to ${SUPERADMIN_ROLE} — dry run, nothing written`,
    )
  } else {
    await client`update "user" set role = ${SUPERADMIN_ROLE} where id = ${target.id}`
    console.log(
      `bootstrap-superadmin: promoted ${target.email} (${target.id}) from ${target.role} to ${SUPERADMIN_ROLE}`,
    )
    console.log('bootstrap-superadmin: sign in, then enter the tier catalogue (docs/deployment/tier-catalogue)')
  }
} catch (err) {
  console.error(`bootstrap-superadmin: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await client.end()
}
