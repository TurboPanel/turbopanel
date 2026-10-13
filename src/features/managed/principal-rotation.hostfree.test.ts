import { assertEquals } from '@std/assert'
import { login, principal } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { rollBackLoginRotation } from './principal-rotation.ts'

const test = Deno.test.bind(Deno)

const secrets = {} as DerivedSecretsConfig
const LOGIN_ID = 'login-1'
const PRINCIPAL_ID = 'principal-1'
const MANAGED_ID = 'managed-1'

/** A login and the legacy principal row it is kept in step with. */
function seedDb() {
  return createMemoryDb([
    [
      login,
      [
        {
          id: LOGIN_ID,
          principalId: PRINCIPAL_ID,
          managedId: MANAGED_ID,
          role: 'user',
          metadata: null,
          password: 'new-hash',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    ],
    [
      principal,
      [
        {
          id: PRINCIPAL_ID,
          kind: 'database',
          managedId: MANAGED_ID,
          password: 'new-hash',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    ],
  ])
}

test('rolling back a rotation restores the password on both rows and rewrites the bound project variables', async () => {
  const db = seedDb()
  const calls: string[] = []
  const result = await rollBackLoginRotation(
    db,
    secrets,
    { loginId: LOGIN_ID, previousPassword: 'old-hash' },
    (_db, _secrets, loginId) => {
      // The stored password is already the old one when the variables are rebuilt from it.
      calls.push(`${loginId}:${db.rows(login)[0]?.password}`)
      return Promise.resolve({ ok: true as const })
    }
  )
  assertEquals(result, { variablesRestored: true })
  assertEquals(calls, [`${LOGIN_ID}:old-hash`])
  assertEquals(db.rows(login)[0]?.password, 'old-hash')
  assertEquals(db.rows(principal)[0]?.password, 'old-hash')
})

test('a failed variable rewrite is reported, and the password is still restored', async () => {
  const db = seedDb()
  const result = await rollBackLoginRotation(
    db,
    secrets,
    { loginId: LOGIN_ID, previousPassword: 'old-hash' },
    () => Promise.resolve({ kind: 'binding_unresolved' } as never)
  )
  assertEquals(result, { variablesRestored: false })
  assertEquals(db.rows(login)[0]?.password, 'old-hash')

  const thrown = await rollBackLoginRotation(
    db,
    secrets,
    { loginId: LOGIN_ID, previousPassword: 'old-hash' },
    () => Promise.reject(new Error('database connection reset'))
  )
  assertEquals(thrown, { variablesRestored: false })
})

test('without a previous password nothing is touched', async () => {
  const db = seedDb()
  let called = false
  const result = await rollBackLoginRotation(
    db,
    secrets,
    { loginId: LOGIN_ID, previousPassword: undefined },
    () => {
      called = true
      return Promise.resolve({ ok: true as const })
    }
  )
  assertEquals(result, { variablesRestored: false })
  assertEquals(called, false)
  assertEquals(db.rows(login)[0]?.password, 'new-hash')
})
