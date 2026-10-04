/**
 * Migration additions guard: additions pass; edits or deletions of shipped
 * migrations and snapshots fail; journal and manifest may change.
 */
import { assertEquals } from '@std/assert'
import { findViolations, resolveBase } from './check-migration-additions.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

test('added migrations and snapshots pass', () => {
  assertEquals(
    findViolations([
      { status: 'A', path: 'migrations/0017_new.sql' },
      { status: 'A', path: 'migrations/meta/0017_snapshot.json' },
    ]),
    []
  )
})

test('editing or deleting an applied migration fails', () => {
  const edited = { status: 'M', path: 'migrations/0013_add_edict_and_bulwark.sql' }
  const deleted = { status: 'D', path: 'migrations/meta/0013_snapshot.json' }
  assertEquals(findViolations([edited, deleted]), [edited, deleted])
})

test('editing a grandfathered migration still fails (grandfathering is forward-only only)', () => {
  const edited = { status: 'M', path: 'migrations/0011_rename_upgradestep_to_stage.sql' }
  assertEquals(findViolations([edited]), [edited])
})

test('journal and manifest may change', () => {
  assertEquals(
    findViolations([
      { status: 'M', path: 'migrations/meta/_journal.json' },
      { status: 'M', path: 'migrations/manifest.json' },
    ]),
    []
  )
})

test('resolveBase skips the -- pnpm forwards', () => {
  assertEquals(resolveBase(['--', 'abc123']), 'abc123')
  assertEquals(resolveBase(['--']), 'origin/trunk')
})
