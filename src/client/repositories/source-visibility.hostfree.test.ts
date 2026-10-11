/**
 * A source may only record a provider repository id its own connection can see
 * (audit P2-1: a shared GitLab app matches pushes by project id alone).
 */
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { RepositorySummary } from '../../features/git/git-provider.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  assertSourceVisibleToConnection,
  type SourceBinding,
  sourceBindingAfterPatch,
} from './source-visibility.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CONNECTION = 'c0000000-0000-4000-8000-000000000001'
const OWN_PROJECT = '101'
const FOREIGN_PROJECT = '202'

function summary(id: string): RepositorySummary {
  return { id, fullName: `group/${id}`, defaultBranch: 'main', private: true, cloneUrl: null }
}

type Case = {
  name: string
  binding: SourceBinding | null
  /** What the connection lists, or an error it throws. */
  listing: RepositorySummary[] | Error
  encrypt?: boolean
  status: number | undefined
  /** Whether the provider is asked at all. */
  listed: boolean
}

const binding = (
  repositoryExternalId: string | null,
  connectionId: string | null = CONNECTION
) => ({
  provider: 'gitlab',
  connectionId,
  repositoryExternalId,
})

const CASES: Case[] = [
  {
    name: 'a project the connection lists is accepted',
    binding: binding(OWN_PROJECT),
    listing: [summary(OWN_PROJECT)],
    status: undefined,
    listed: true,
  },
  {
    name: 'a project the connection cannot see is refused as 404',
    binding: binding(FOREIGN_PROJECT),
    listing: [summary(OWN_PROJECT)],
    status: 404,
    listed: true,
  },
  {
    name: 'a provider failure is mapped by the caller',
    binding: binding(FOREIGN_PROJECT),
    listing: new Error('provider down'),
    status: 502,
    listed: true,
  },
  {
    name: 'no data-encryption secrets answers 503 before asking the provider',
    binding: binding(OWN_PROJECT),
    listing: [summary(OWN_PROJECT)],
    encrypt: false,
    status: 503,
    listed: false,
  },
  {
    name: 'a binding without a provider id needs no proof',
    binding: binding(null),
    listing: [],
    status: undefined,
    listed: false,
  },
  {
    name: 'a binding without a connection needs no proof',
    binding: binding(FOREIGN_PROJECT, null),
    listing: [],
    status: undefined,
    listed: false,
  },
  {
    name: 'a GitHub binding is installation-scoped and needs no proof',
    binding: { ...binding(FOREIGN_PROJECT), provider: 'github' },
    listing: [],
    status: undefined,
    listed: false,
  },
  {
    name: 'a patch that touches neither field needs no proof',
    binding: null,
    listing: [],
    status: undefined,
    listed: false,
  },
]

async function run(entry: Case): Promise<{ status: number | undefined; listed: boolean }> {
  const secrets =
    entry.encrypt === false
      ? undefined
      : await deriveEncryptionSecretsConfig(parseTestSecretsConfig('deno'), 'data-encryption')
  let listed = false
  const provider = {
    listRepositories: (_ctx: unknown, connectionId: string) => {
      listed = true
      assertEquals(connectionId, CONNECTION)
      return entry.listing instanceof Error
        ? Promise.reject(entry.listing)
        : Promise.resolve(entry.listing)
    },
  }
  const app = new Hono<AppEnv>()
  app.get('/', async (c) => {
    if (secrets) c.set('dataEncryptionSecrets', secrets)
    const denied = await assertSourceVisibleToConnection(
      c,
      {} as Db,
      entry.binding,
      () => c.json({ error: 'git_provider_request_failed' }, 502),
      () => provider
    )
    return denied ?? c.body(null, 204)
  })
  const res = await app.request('/')
  await res.body?.cancel()
  return { status: res.status === 204 ? undefined : res.status, listed }
}

for (const entry of CASES) {
  test(`assertSourceVisibleToConnection: ${entry.name}`, async () => {
    assertEquals(await run(entry), { status: entry.status, listed: entry.listed })
  })
}

test('sourceBindingAfterPatch overlays patched fields on the stored row', () => {
  const stored = binding(OWN_PROJECT)
  assertEquals(sourceBindingAfterPatch(stored, {}), null)
  assertEquals(sourceBindingAfterPatch(stored, { repositoryExternalId: FOREIGN_PROJECT }), {
    ...stored,
    repositoryExternalId: FOREIGN_PROJECT,
  })
  assertEquals(sourceBindingAfterPatch(stored, { connectionId: null }), {
    ...stored,
    connectionId: null,
  })
})

function forgeDb(baseUrl: string | null): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve(baseUrl === null ? [] : [{ baseUrl }]) }),
        }),
      }),
    }),
  } as unknown as Db
}

async function hostCheck(db: Db, b: SourceBinding): Promise<number | undefined> {
  const app = new Hono<AppEnv>()
  app.get('/', async (c) => {
    const denied = await assertSourceVisibleToConnection(
      c,
      db,
      b,
      () => new Response(null, { status: 500 })
    )
    return denied ?? c.json({ ok: true })
  })
  return (await app.request('/')).status
}

test('a connection-bound url must be on the forge host, for every provider', async () => {
  const github = (repositoryUrl: string): SourceBinding => ({
    provider: 'github',
    connectionId: CONNECTION,
    repositoryExternalId: null,
    repositoryUrl,
  })
  const db = forgeDb('https://github.com')
  assertEquals(await hostCheck(db, github('https://github.com/acme/app.git')), 200)
  assertEquals(await hostCheck(db, github('https://attacker.example/acme/app.git')), 400)
  assertEquals(await hostCheck(db, github('https://github.com@attacker.example/acme/app.git')), 400)
  // An unknown connection or forge is a mismatch, never a pass.
  assertEquals(await hostCheck(forgeDb(null), github('https://github.com/acme/app.git')), 400)
  // No connection, or no url to judge, is not this check's business.
  assertEquals(
    await hostCheck(db, { ...github('https://attacker.example/x.git'), connectionId: null }),
    200
  )
  assertEquals(await hostCheck(db, { ...github(''), repositoryUrl: undefined }), 200)
})

test('sourceBindingAfterPatch carries the url, so a connection change re-checks the stored one', () => {
  const stored: SourceBinding = {
    ...binding(OWN_PROJECT),
    repositoryUrl: 'https://gitlab.com/g/a.git',
  }
  assertEquals(sourceBindingAfterPatch(stored, { repositoryUrl: 'https://evil.example/g/a.git' }), {
    ...stored,
    repositoryUrl: 'https://evil.example/g/a.git',
  })
  assertEquals(sourceBindingAfterPatch(stored, { connectionId: null }), {
    ...stored,
    connectionId: null,
  })
})
