import { assertRejects, assertThrows } from '@std/assert'
import { createDenoDb, createToolingDb, withToolingDb } from './db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createDenoDb throws when TURBOPANEL_DATABASE_URL is unset', () => {
  const previous = Deno.env.get('TURBOPANEL_DATABASE_URL')
  const previousDatabase = Deno.env.get('DATABASE_URL')
  Deno.env.delete('TURBOPANEL_DATABASE_URL')
  Deno.env.delete('DATABASE_URL')

  try {
    assertThrows(
      () => createDenoDb(),
      Error,
      'TURBOPANEL_DATABASE_URL is required',
    )
  } finally {
    if (previous !== undefined) Deno.env.set('TURBOPANEL_DATABASE_URL', previous)
    if (previousDatabase !== undefined) Deno.env.set('DATABASE_URL', previousDatabase)
  }
})

test('withToolingDb throws when database URL is missing', async () => {
  const previous = Deno.env.get('TURBOPANEL_DATABASE_URL')
  const previousDatabase = Deno.env.get('DATABASE_URL')
  Deno.env.delete('TURBOPANEL_DATABASE_URL')
  Deno.env.delete('DATABASE_URL')

  try {
    await assertRejects(
      () => withToolingDb(async () => 'unused'),
      Error,
      'TURBOPANEL_DATABASE_URL is required',
    )
  } finally {
    if (previous !== undefined) Deno.env.set('TURBOPANEL_DATABASE_URL', previous)
    if (previousDatabase !== undefined) Deno.env.set('DATABASE_URL', previousDatabase)
  }
})

test('createToolingDb throws when database URL is missing', () => {
  const previous = Deno.env.get('TURBOPANEL_DATABASE_URL')
  const previousDatabase = Deno.env.get('DATABASE_URL')
  Deno.env.delete('TURBOPANEL_DATABASE_URL')
  Deno.env.delete('DATABASE_URL')

  try {
    assertThrows(
      () => createToolingDb(),
      Error,
      'TURBOPANEL_DATABASE_URL is required',
    )
  } finally {
    if (previous !== undefined) Deno.env.set('TURBOPANEL_DATABASE_URL', previous)
    if (previousDatabase !== undefined) Deno.env.set('DATABASE_URL', previousDatabase)
  }
})
