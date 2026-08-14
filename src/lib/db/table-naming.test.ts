/**
 * Guard: physical CREATE TABLE names must stay single lower-case words
 * (no underscores). Squashed baseline lives at migrations/0000_init.sql.
 */

import { assertEquals } from 'jsr:@std/assert'
import { dirname, fromFileUrl, join } from 'jsr:@std/path'

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

test('migrations/0000_init.sql CREATE TABLE names are single lower-case words', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const sqlPath = join(here, '../../../migrations/0000_init.sql')
  const sql = await Deno.readTextFile(sqlPath)
  const names = extractCreateTableNames(sql)
  if (names.length === 0) {
    throw new TypeError('expected at least one CREATE TABLE in 0000_init.sql')
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
  if (!unique.includes('steward')) {
    throw new TypeError('expected principal-service table "steward"')
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
    unique.includes('peer')
  ) {
    throw new TypeError(
      'retired table names member / membership / managed_member / router / attachment / span / assignment / bridge / vpn / peer must not reappear',
    )
  }

  // Every listed exception must still exist in the migration (no stale exceptions)
  for (const exception of [...PHYSICAL_TABLE_NAME_EXCEPTIONS].sort((a, b) =>
    a.localeCompare(b)
  )) {
    if (!unique.includes(exception)) {
      throw new TypeError(
        `exception "${exception}" is not present in 0000_init.sql — remove it from the test allowlist`,
      )
    }
  }

  assertEquals(unique.includes('2fa'), true)
})
