import { assertEquals } from '@std/assert'
import {
  decideDirectoryDefaultsPatch,
  directoryDefaultsOptionChanges,
  directoryDefaultsResponse,
  parseDirectoryDefaultsPatch,
} from './directory-defaults.ts'
import { parseOrganizationOptions, resolveDirectoryNames } from './organization-options.ts'

const test = Deno.test.bind(Deno)

test('the folder-name setting reads from options, drops bad values and defaults to slug', () => {
  assertEquals(resolveDirectoryNames({}), { mode: 'slug', locked: false })
  assertEquals(
    resolveDirectoryNames(
      parseOrganizationOptions({ directoryNames: 'both', directoryNamesLocked: true })
    ),
    { mode: 'both', locked: true }
  )
  assertEquals(
    parseOrganizationOptions({ directoryNames: 'folder', directoryNamesLocked: 'yes' }),
    {}
  )
})

test('parseDirectoryDefaultsPatch needs one known field of the right type', () => {
  assertEquals(parseDirectoryDefaultsPatch({ names: 'uuid' }), {
    ok: true,
    patch: { names: 'uuid' },
  })
  assertEquals(parseDirectoryDefaultsPatch({ names: null, locked: true }), {
    ok: true,
    patch: { names: null, locked: true },
  })
  for (const body of [
    null,
    [],
    {},
    { names: 'x' },
    { names: 1 },
    { locked: 'true' },
    { other: 1 },
  ]) {
    assertEquals(parseDirectoryDefaultsPatch(body), { ok: false })
  }
})

test('directoryDefaultsOptionChanges sets, clears and locks', () => {
  assertEquals(directoryDefaultsOptionChanges({ names: 'both', locked: true }), {
    remove: [],
    set: { directoryNames: 'both', directoryNamesLocked: true },
  })
  assertEquals(directoryDefaultsOptionChanges({ names: null, locked: false }), {
    remove: ['directoryNames', 'directoryNamesLocked'],
    set: {},
  })
})

test('decideDirectoryDefaultsPatch locks by the flag or by an existing folder', () => {
  const locked = { directoryNames: 'slug', directoryNamesLocked: true } as const
  assertEquals(decideDirectoryDefaultsPatch({ names: 'uuid' }, {}, false), { ok: true })
  assertEquals(decideDirectoryDefaultsPatch({ names: 'uuid' }, locked, false), {
    ok: false,
    error: 'directory_names_locked',
  })
  assertEquals(decideDirectoryDefaultsPatch({ names: 'uuid', locked: false }, locked, false), {
    ok: true,
  })
  assertEquals(decideDirectoryDefaultsPatch({ names: 'slug' }, locked, false), { ok: true })
  assertEquals(decideDirectoryDefaultsPatch({ names: null }, locked, false), { ok: true })
  assertEquals(decideDirectoryDefaultsPatch({ names: 'uuid' }, {}, true), {
    ok: false,
    error: 'directory_names_locked',
  })
  assertEquals(decideDirectoryDefaultsPatch({ locked: false }, {}, true), {
    ok: false,
    error: 'directory_names_locked',
  })
  assertEquals(decideDirectoryDefaultsPatch({ names: 'slug' }, {}, true), { ok: true })
})

test('directoryDefaultsResponse says why it is locked', () => {
  assertEquals(directoryDefaultsResponse({}, true), {
    names: null,
    effectiveNames: 'slug',
    locked: true,
    lockedByFolders: true,
  })
  assertEquals(
    directoryDefaultsResponse({ directoryNames: 'uuid', directoryNamesLocked: true }, false),
    {
      names: 'uuid',
      effectiveNames: 'uuid',
      locked: true,
      lockedByFolders: false,
    }
  )
})
