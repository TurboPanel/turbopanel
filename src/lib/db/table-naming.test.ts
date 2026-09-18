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
const RENAME_TABLE_RE = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/gi

function extractCreateTableNames(sql: string): string[] {
  const names: string[] = []
  for (const match of sql.matchAll(CREATE_TABLE_RE)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

/** `[from, to]` pairs, in statement order. */
export function extractTableRenames(sql: string): Array<[string, string]> {
  const renames: Array<[string, string]> = []
  for (const match of sql.matchAll(RENAME_TABLE_RE)) {
    const from = match[1]
    const to = match[2]
    if (from !== undefined && to !== undefined) renames.push([from, to])
  }
  return renames
}

/**
 * The physical names a database holds after replaying the files in order:
 * every CREATE TABLE, with each later `ALTER TABLE … RENAME TO` retiring the
 * old name and adding the new. A shipped file is immutable, so a table that
 * was created under a name the policy rejects can only be brought into line
 * by a forward rename — and it is the *current* name the policy judges.
 */
export function accumulatePhysicalTableNames(sqlInOrder: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const sql of sqlInOrder) {
    for (const name of extractCreateTableNames(sql)) names.add(name)
    for (const [from, to] of extractTableRenames(sql)) {
      names.delete(from)
      names.add(to)
    }
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

  // Renames are folded in file order (NNNN_ prefixes sort the same way the
  // journal does): 0002_notifications created three tables under names this
  // policy rejects, and 0003 renamed them — the shipped file cannot change,
  // so the set judged is what a replayed database actually holds.
  const sqlInOrder: string[] = []
  for (const file of sqlFiles) {
    sqlInOrder.push(await Deno.readTextFile(join(migrationsDir, file)))
  }
  const accumulated = accumulatePhysicalTableNames(sqlInOrder)
  if (accumulated.size === 0) {
    throw new TypeError(
      'expected at least one CREATE TABLE in scanned migration SQL files under migrations/',
    )
  }

  const unique = [...accumulated].sort((a, b) => a.localeCompare(b))
  for (const name of unique) {
    assertPhysicalTableName(name)
  }

  // Sanity: renames from this policy change stay in the baseline
  if (!unique.includes('teammate')) {
    throw new TypeError('expected team-membership table "teammate"')
  }
  if (!unique.includes('replica')) {
    throw new TypeError('expected managed-cluster participation table "replica"')
  }
  if (!unique.includes('fabric') || !unique.includes('relay') || !unique.includes('subnet')) {
    throw new TypeError('expected TurboFabric tables fabric / relay / subnet')
  }
  if (!unique.includes('storage') || !unique.includes('copy') || !unique.includes('mount')) {
    throw new TypeError('expected storage tables storage / copy / mount')
  }
  if (!unique.includes('secret')) {
    throw new TypeError('expected secret table')
  }
  if (!unique.includes('leaf') || !unique.includes('changeover')) {
    throw new TypeError('expected Organization CA tables leaf / changeover')
  }
  if (!unique.includes('tenancy')) {
    throw new TypeError('expected principal-service table "tenancy"')
  }
  if (!unique.includes('forge') || !unique.includes('connection') || !unique.includes('repository')) {
    throw new TypeError('expected Git tables forge / connection / repository')
  }
  if (!unique.includes('slot')) {
    throw new TypeError('expected replica-slot table "slot"')
  }
  if (!unique.includes('channel') || !unique.includes('rule') || !unique.includes('attempt')) {
    throw new TypeError('expected notification tables channel / rule / attempt')
  }
  if (unique.includes('notification_channel')) {
    throw new TypeError('the 0003 rename must retire "notification_channel"')
  }
  if (!unique.includes('tag') || !unique.includes('marker')) {
    throw new TypeError('expected tagging tables tag / marker')
  }
  if (!unique.includes('task')) {
    throw new TypeError('expected cron table "task"')
  }
  if (!unique.includes('entitlement')) {
    throw new TypeError('expected principal-runtime-grant table "entitlement"')
  }
  if (!unique.includes('ssh')) {
    throw new TypeError('expected principal-ssh-key table "ssh"')
  }
  if (!unique.includes('payer') || !unique.includes('subscription') || !unique.includes('seat')) {
    throw new TypeError('expected billing projection tables payer / subscription / seat')
  }
  if (unique.includes('subscription_item') || unique.includes('subscriptionitem')) {
    throw new TypeError('subscription items are the one-word physical table "seat"')
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
    unique.includes('principal_ssh_key') ||
    unique.includes('gitapp') ||
    unique.includes('installation') ||
    unique.includes('source') ||
    unique.includes('steward') ||
    unique.includes('location') ||
    unique.includes('credential') ||
    unique.includes('node') ||
    unique.includes('segment') ||
    unique.includes('rotation')
  ) {
    throw new TypeError(
      'retired table names member / membership / managed_member / router / attachment / span / assignment / bridge / vpn / peer / tlsleaf / tlsrotation / principal_entitlement / principal_ssh_key / gitapp / installation / source / steward / location / credential / node / segment / rotation must not reappear',
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

test('a forward rename retires the old physical name and judges the new one', () => {
  const names = accumulatePhysicalTableNames([
    'CREATE TABLE "notification_channel" (id uuid);',
    'ALTER TABLE "notification_channel" RENAME TO "channel";--> statement-breakpoint\nCREATE TABLE "rule" (id uuid);',
  ])
  assertEquals([...names].sort(), ['channel', 'rule'])
  assertEquals(extractTableRenames('ALTER TABLE "a" RENAME TO "b"; ALTER TABLE "b" RENAME TO "c";'), [
    ['a', 'b'],
    ['b', 'c'],
  ])
})
