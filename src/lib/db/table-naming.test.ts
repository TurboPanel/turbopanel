/**
 * Guard: physical CREATE TABLE names must stay single lower-case words
 * (no underscores). Scans every NNNN_*.sql file under migrations/.
 */

import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Physical table names that intentionally break the single-word rule (or the
 * leading-letter form of it) because an external model depends on the name.
 *
 * | Name | Why |
 * | --- | --- |
 * | `2fa` | Better Auth two-factor model — digit-leading physical name; map via schema model when wiring BA |
 */
const PHYSICAL_TABLE_NAME_EXCEPTIONS = new Set<string>(['2fa'])

/** One standalone lower-case word: letter-first, alphanumeric only, no underscores. */
const PHYSICAL_TABLE_NAME_RE = /^[a-z][a-z0-9]*$/

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+"([^"]+)"/gi

function extractCreateTableNames(sql: string): string[] {
  const names: string[] = []
  for (const match of sql.matchAll(CREATE_TABLE_RE)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

function assertPhysicalTableName(name: string): void {
  if (PHYSICAL_TABLE_NAME_EXCEPTIONS.has(name)) return
  if (!PHYSICAL_TABLE_NAME_RE.test(name)) {
    throw new TypeError(
      `physical table "${name}" must be one lower-case word (no underscores); ` +
        `add an explicit exception only for external compatibility`,
    )
  }
  if (name.includes('_')) {
    throw new TypeError(`physical table "${name}" must not contain underscores`)
  }
}

test('migrations/ CREATE TABLE names are single lower-case words', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const migrationsDir = join(here, '../../../migrations')
  const sqlFiles: string[] = []
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (!entry.isFile) continue
    if (!/^\d{4}_.*\.sql$/.test(entry.name)) continue
    sqlFiles.push(entry.name)
  }
  sqlFiles.sort((a, b) => a.localeCompare(b))
  if (sqlFiles.length === 0) {
    throw new TypeError('expected at least one NNNN_*.sql file under migrations/')
  }

  // Known limitation: a future forward migration that does ALTER TABLE …
  // RENAME TO would leave the old CREATE TABLE name visible in an earlier
  // file and trip the retired-name reject on legitimate history. Handling
  // this means folding ALTER TABLE … RENAME TO statements into the
  // accumulated name set while scanning in _journal.json order. Deliberately
  // not implemented now — the squash removed all rename history.

  const names: string[] = []
  for (const file of sqlFiles) {
    const sql = await Deno.readTextFile(join(migrationsDir, file))
    names.push(...extractCreateTableNames(sql))
  }
  if (names.length === 0) {
    throw new TypeError(
      'expected at least one CREATE TABLE in scanned migration SQL files under migrations/',
    )
  }

  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b))
  for (const name of unique) {
    assertPhysicalTableName(name)
  }

  // Sanity: renames from this policy change stay in the baseline
  if (!unique.includes('teammate')) {
    throw new TypeError('expected team-membership table "teammate"')
  }
  if (!unique.includes('node')) {
    throw new TypeError('expected managed-cluster participation table "node"')
  }
  if (!unique.includes('fabric') || !unique.includes('relay') || !unique.includes('segment')) {
    throw new TypeError('expected TurboFabric tables fabric / relay / segment')
  }
  if (!unique.includes('storage') || !unique.includes('location') || !unique.includes('mount')) {
    throw new TypeError('expected storage tables storage / location / mount')
  }
  if (!unique.includes('credential')) {
    throw new TypeError('expected credential table')
  }
  if (!unique.includes('leaf') || !unique.includes('rotation')) {
    throw new TypeError('expected Organization CA tables leaf / rotation')
  }
  if (!unique.includes('steward')) {
    throw new TypeError('expected principal-service table "steward"')
  }
  if (!unique.includes('entitlement')) {
    throw new TypeError('expected principal-runtime-grant table "entitlement"')
  }
  if (!unique.includes('ssh')) {
    throw new TypeError('expected principal-ssh-key table "ssh"')
  }
  if (
    unique.includes('member') ||
    unique.includes('membership') ||
    unique.includes('managed_member') ||
    unique.includes('router') ||
    unique.includes('attachment') ||
    unique.includes('span') ||
    unique.includes('assignment') ||
    unique.includes('bridge') ||
    unique.includes('vpn') ||
    unique.includes('peer') ||
    unique.includes('tlsleaf') ||
    unique.includes('tlsrotation') ||
    unique.includes('principal_entitlement') ||
    unique.includes('principal_ssh_key')
  ) {
    throw new TypeError(
      'retired table names member / membership / managed_member / router / attachment / span / assignment / bridge / vpn / peer / tlsleaf / tlsrotation / principal_entitlement / principal_ssh_key must not reappear',
    )
  }

  // Every listed exception must still exist in the migration (no stale exceptions)
  for (const exception of [...PHYSICAL_TABLE_NAME_EXCEPTIONS].sort((a, b) =>
    a.localeCompare(b)
  )) {
    if (!unique.includes(exception)) {
      throw new TypeError(
        `exception "${exception}" is not present in scanned migration SQL files under migrations/ — remove it from the test allowlist`,
      )
    }
  }

  assertEquals(unique.includes('2fa'), true)
})
