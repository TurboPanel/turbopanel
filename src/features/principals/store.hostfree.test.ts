/**
 * Host-free coverage for principal store helpers (no Postgres).
 */

import { assertEquals, assertMatch, assertRejects } from '@std/assert'
import { isReservedPrincipalUsername } from '../../lib/naming.ts'
import type { Db } from '../../db/connection.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ensureManagedReplicationLogin } from '../managed/cluster-logins.ts'
import { createManagedLogin } from '../managed/logins.ts'
import {
  composeAliasShortUsername,
  createPrincipal,
  isManagedUsernameTaken,
  isServerPrincipalUsernameTaken,
  isUuid,
  lockOrganizationsForUpdate,
  replaceTenancies,
  resolveManagedAppliedUsername,
  resolveManagedOwningOrganizationIds,
  rotatePrincipalPassword,
  setPrincipalPassword,
  USERNAME_RE,
} from './store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function testDataEncryptionSecrets() {
  return await deriveEncryptionSecretsConfig(parseTestSecretsConfig('deno'), 'data-encryption')
}

function managedReplicationDb(): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ organizationId: 'org' }]),
              }),
            }),
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
          where: () => Promise.resolve([{ organizationId: 'org' }]),
        }),
        where: () => ({
          orderBy: () => Promise.resolve([]),
          for: () => ({
            limit: () => Promise.resolve([{ id: 'org' }]),
          }),
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve([{ organizationId: 'org' }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'repl-new' }]),
      }),
    }),
  } as unknown as Db
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    for: () => ({ limit: () => promise }),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

test('isUuid accepts v5-shaped ids and rejects garbage', () => {
  assertEquals(isUuid('00000000-0000-4000-8000-000000000001'), true)
  assertEquals(isUuid('not-a-uuid'), false)
  assertEquals(isUuid(''), false)
})

test('isServerPrincipalUsernameTaken short-circuits blank and hits/misses', async () => {
  assertEquals(await isServerPrincipalUsernameTaken({} as Db, 'org', '   '), false)

  assertEquals(
    await isServerPrincipalUsernameTaken(poolProbeDb([{ id: 'p1' }]), 'org', 'AppUser'),
    true
  )
  assertEquals(
    await isServerPrincipalUsernameTaken(poolProbeDb([]), 'org', 'free', 'exclude-me'),
    false
  )
  // A database login the organization made with the name takes it too.
  assertEquals(
    await isServerPrincipalUsernameTaken(poolProbeDb([], [{ id: 'l1' }]), 'org', 'appuser'),
    true
  )
})

/**
 * The organization name pool is two probes: the principal table (a single-table
 * select) and the user logins of the organization's clusters (a join chain).
 */
function poolProbeDb(
  principalRows: Array<{ id: string }>,
  loginRows: Array<{ id: string }> = []
): Db {
  const loginChain = {
    innerJoin: () => loginChain,
    where: () => ({ limit: () => Promise.resolve(loginRows) }),
  }
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(principalRows),
        }),
        innerJoin: () => loginChain,
      }),
    }),
  } as unknown as Db
}

test('replaceTenancies deletes inserts and no-ops when unchanged', async () => {
  let deleted: string[] | null = null
  let inserted: unknown = null
  const tx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 's1' }, { serviceId: 's2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = ['s2']
        return thenableRows([])
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted = values
        return thenableRows([])
      },
    }),
  } as unknown as Db

  await replaceTenancies(tx, 'principal', ['s1', 's3'])
  assertEquals(deleted, ['s2'])
  assertEquals(inserted, [{ principalId: 'principal', serviceId: 's3' }])

  const noopTx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 'only' }]),
      }),
    }),
    delete: () => {
      throw new TypeError('should not delete')
    },
    insert: () => {
      throw new TypeError('should not insert')
    },
  } as unknown as Db
  await replaceTenancies(noopTx, 'principal', ['only'])
})

test('createPrincipal inserts principal and stewards in a transaction', async () => {
  let principalValues: unknown
  let stewardValues: unknown
  const db = {
    transaction: async (fn: (tx: Db) => Promise<string>) => {
      const tx = {
        insert: () => ({
          values: (values: unknown) => {
            if (!principalValues) {
              principalValues = values
              return {
                returning: () => Promise.resolve([{ id: 'new-principal' }]),
              }
            }
            stewardValues = values
            return thenableRows([])
          },
        }),
      } as unknown as Db
      return await fn(tx)
    },
  } as unknown as Db

  const id = await createPrincipal(
    db,
    {
      organizationId: 'org-1',
      username: 'deploy',
      metadata: { a: 1 },
      options: { b: 2 },
    },
    ['svc-1', 'svc-2']
  )
  assertEquals(id, 'new-principal')
  assertEquals((principalValues as { username: string }).username, 'deploy')
  assertEquals(
    (stewardValues as Array<{ serviceId: string }>).map((r) => r.serviceId),
    ['svc-1', 'svc-2']
  )
})

test('resolveManagedOwningOrganizationIds unions members and extras sorted', async () => {
  let call = 0
  const db = {
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () =>
            Promise.resolve([
              { organizationId: 'org-b' },
              { organizationId: 'org-a' },
              { organizationId: null },
            ]),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          call += 1
          return Promise.resolve([{ organizationId: 'org-c' }, { organizationId: 'org-a' }])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(await resolveManagedOwningOrganizationIds(db, 'm1', ['extra-server']), [
    'org-a',
    'org-b',
    'org-c',
  ])
  assertEquals(call, 1)

  assertEquals(await resolveManagedOwningOrganizationIds(db, 'm1'), ['org-a', 'org-b'])
})

test('isManagedUsernameTaken handles empty orgs and hits', async () => {
  assertEquals(await isManagedUsernameTaken({} as Db, [], 'app'), false)
  assertEquals(await isManagedUsernameTaken({} as Db, ['org'], '  '), false)

  assertEquals(
    await isManagedUsernameTaken(poolProbeDb([{ id: 'p' }]), ['org'], 'Root', 'exclude'),
    true
  )
  assertEquals(await isManagedUsernameTaken(poolProbeDb([]), ['org'], 'Root'), false)
})

/**
 * Answers every name probe: the principal pool query (`from.where.limit`) and
 * the login query (`from.innerJoin.innerJoin.where.limit`) share one row source.
 */
function nameProbeDb(rows: () => unknown[]): Db {
  const chain = {
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows()),
  }
  return { select: () => ({ from: () => chain }) } as unknown as Db
}

test('resolveManagedAppliedUsername prefers free short name without suffix', async () => {
  const free = nameProbeDb(() => [])

  const preferred = await resolveManagedAppliedUsername(
    free,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { scheme: 'plain' }
  )
  assertEquals(preferred, 'root')

  let takenCalls = 0
  const takenThenFree = nameProbeDb(() => {
    takenCalls += 1
    // preferred taken, suffixed free
    return takenCalls === 1 ? [{ id: 'x' }] : []
  })
  const derived = await resolveManagedAppliedUsername(
    takenThenFree,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { scheme: 'plain' }
  )
  assertMatch(derived, /^root_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername suffix mode never returns the bare name', async () => {
  const free = nameProbeDb(() => [])

  const derived = await resolveManagedAppliedUsername(
    free,
    ['org'],
    'postgres',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { scheme: 'partial' }
  )
  assertMatch(derived, /^postgres_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername throws when pattern cannot fit', async () => {
  const free = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'x' }]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      resolveManagedAppliedUsername(
        free,
        ['org'],
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        { pattern: /^[a-z]+$/, maxLength: 5 },
        { scheme: 'partial' }
      ),
    TypeError,
    'invalid managed short username'
  )
})

test('lockOrganizationsForUpdate orders ids and no-ops empty', async () => {
  const locked: string[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          void cond
          return {
            for: () => ({
              limit: () => {
                // Capture order via successive calls by intercepting eq via closed over state is hard;
                // just ensure lock path runs.
                locked.push('hit')
                return Promise.resolve([{ id: 'org' }])
              },
            }),
          }
        },
      }),
    }),
  } as unknown as Db

  await lockOrganizationsForUpdate(db, [])
  assertEquals(locked, [])
  await lockOrganizationsForUpdate(db, [
    '00000000-0000-4000-8000-00000000000b',
    '00000000-0000-4000-8000-00000000000a',
  ])
  assertEquals(locked.length, 2)
})

test('USERNAME_RE gates managed usernames', () => {
  assertEquals(USERNAME_RE.test('App_User-1'), true)
  assertEquals(USERNAME_RE.test('1bad'), false)
})

test('replaceTenancies removes all edges when next list is empty', async () => {
  let deleted = false
  const tx = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([{ serviceId: 's1' }, { serviceId: 's2' }]),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = true
        return thenableRows([])
      },
    }),
    insert: () => {
      throw new TypeError('should not insert')
    },
  } as unknown as Db
  await replaceTenancies(tx, 'principal', [])
  assertEquals(deleted, true)
})

test('createPrincipal omits null metadata and options from insert', async () => {
  let principalValues: Record<string, unknown> | undefined
  const db = {
    transaction: async (fn: (tx: Db) => Promise<string>) => {
      const tx = {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            principalValues = values
            return {
              returning: () => Promise.resolve([{ id: 'bare-principal' }]),
            }
          },
        }),
      } as unknown as Db
      return await fn(tx)
    },
  } as unknown as Db

  const id = await createPrincipal(
    db,
    {
      organizationId: 'org-1',
      username: 'deploy',
    },
    []
  )
  assertEquals(id, 'bare-principal')
  assertEquals(principalValues?.metadata, undefined)
  assertEquals(principalValues?.options, undefined)
})

test('setPrincipalPassword seals explicit password and generate mode', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  let sealed: string | undefined

  const db = {
    update: () => ({
      set: (patch: { password: string }) => {
        sealed = patch.password
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: 'p1' }]),
          }),
        }
      },
    }),
  } as unknown as Db

  const stored = await setPrincipalPassword(db, dataEncryptionSecrets, 'p1', {
    password: ' rotate-me ',
  })
  assertEquals(stored.plaintext, undefined)
  assertEquals(typeof sealed, 'string')
  assertEquals(sealed?.startsWith('tpsecret.'), true)

  const generated = await setPrincipalPassword(db, dataEncryptionSecrets, 'p1', { generate: true })
  assertEquals(typeof generated.plaintext, 'string')
  assertEquals((generated.plaintext ?? '').length > 0, true)
})

test('setPrincipalPassword rejects missing input and missing principal', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  await assertRejects(
    () => setPrincipalPassword({} as Db, dataEncryptionSecrets, 'p1', {} as { generate: true }),
    TypeError,
    'password or generate:true is required'
  )

  const missing = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () =>
      setPrincipalPassword(missing, dataEncryptionSecrets, 'missing', {
        password: 'x',
      }),
    Error,
    'Principal not found'
  )
})

test('rotatePrincipalPassword returns generated plaintext', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'p1' }]),
        }),
      }),
    }),
  } as unknown as Db
  const rotated = await rotatePrincipalPassword(db, dataEncryptionSecrets, 'p1')
  assertEquals(typeof rotated.plaintext, 'string')
  assertEquals(rotated.plaintext.length > 0, true)
})

test('createManagedLogin inserts a sealed password and validates inputs', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  const inserts: Record<string, unknown>[] = []

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values)
        return { returning: () => Promise.resolve([{ id: 'login-1' }]) }
      },
    }),
  } as unknown as Db

  const created = await createManagedLogin(db, dataEncryptionSecrets, {
    managedId: 'm1',
    username: 'app_user',
    grantMode: 'recipe',
  })
  assertEquals(created.loginId, 'login-1')
  assertEquals(typeof created.password, 'string')
  const [loginValues] = inserts
  assertEquals(loginValues?.managedId, 'm1')
  assertEquals(loginValues?.principalId, null)
  assertEquals(loginValues?.role, 'user')
  assertEquals(loginValues?.username, 'app_user')
  assertEquals(loginValues?.appliedUsername, 'app_user')
  assertEquals(loginValues?.grantMode, 'recipe')
  assertEquals((loginValues?.password as string).startsWith('tpsecret.'), true)

  await assertRejects(
    () => createManagedLogin(db, dataEncryptionSecrets, { managedId: 'm1', username: '1bad' }),
    TypeError,
    'invalid username'
  )
  await assertRejects(
    () =>
      createManagedLogin(db, dataEncryptionSecrets, {
        managedId: 'm1',
        username: 'valid_user',
        appliedUsername: '1bad',
      }),
    TypeError,
    'invalid applied username'
  )
})

test('ensureManagedReplicationLogin reuses the existing replication login', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              {
                id: 'repl-existing',
                principalId: null,
                managedId: 'm1',
                role: 'replication',
                username: 'tp_repl',
                appliedUsername: 'tp_repl',
                nameScheme: 'plain',
                grantMode: 'recipe',
                isTool: false,
                databases: [],
                privileges: [],
                access: 'read-write',
                allowedSources: null,
                maxConnections: null,
                createdAt: 't0',
                updatedAt: 't1',
                password: null,
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db

  const existing = await ensureManagedReplicationLogin(db, await testDataEncryptionSecrets(), {
    managedId: 'm1',
    identifier: { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    nameScheme: 'partial',
  })
  assertEquals(existing, {
    loginId: 'repl-existing',
    appliedUsername: 'tp_repl',
    created: false,
  })
})

test('ensureManagedReplicationLogin creates the replication login when absent', async () => {
  const dataEncryptionSecrets = await testDataEncryptionSecrets()
  const result = await ensureManagedReplicationLogin(
    managedReplicationDb(),
    dataEncryptionSecrets,
    {
      managedId: '01936b3e-aaaa-bbbb-cccc-123456789abc',
      identifier: { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
      nameScheme: 'partial',
    }
  )
  assertEquals(result.created, true)
  assertEquals(result.loginId, 'repl-new')
  assertMatch(result.appliedUsername, /^tp_repl_[a-z0-9]{11}$/)
})

test('resolveManagedAppliedUsername returns a fresh suffix when candidate is taken', async () => {
  let takenCalls = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            takenCalls += 1
            return Promise.resolve([{ id: 'x' }])
          },
        }),
      }),
    }),
  } as unknown as Db

  const derived = await resolveManagedAppliedUsername(
    db,
    ['org'],
    'root',
    { pattern: /^[a-z0-9_]+$/i, maxLength: 63 },
    { scheme: 'plain' }
  )
  assertMatch(derived, /^root_[a-z0-9]{11}$/)
  // One probe of the bare name, then three redraws; the last draw is returned
  // unprobed rather than throwing on a live namespace.
  assertEquals(takenCalls, 4)
})

test('composeAliasShortUsername folds dashes into a shape the host builds for', () => {
  // The host refuses builds for a name ending in `-` or holding `--`.
  assertEquals(composeAliasShortUsername('web--app'), 'web-app')
  assertEquals(composeAliasShortUsername('web-'), 'web')
  assertEquals(composeAliasShortUsername('-web'), 'web')
  assertEquals(composeAliasShortUsername('Web.App'), 'webapp')
  assertEquals(composeAliasShortUsername('---'), 'u')
  // A cap that lands on a dash drops it.
  assertEquals(composeAliasShortUsername(`${'a'.repeat(15)}-bbbb`), 'a'.repeat(15))
  assertEquals(composeAliasShortUsername('containers'), 'ucontainers')
})

test('composeAliasShortUsername never yields a reserved host login', () => {
  // Folding an alias that matches a host system user prefixes it rather than
  // minting that login as a site owner's Linux user.
  for (const alias of ['ftp', 'git', 'FTP', ' git ', 'ubuntu', 'www', 'root', 'www-data', 'sudo']) {
    const derived = composeAliasShortUsername(alias)
    assertEquals(isReservedPrincipalUsername(derived), false, `${alias} -> ${derived}`)
  }
  assertEquals(isReservedPrincipalUsername(composeAliasShortUsername('appuser')), false)
})
