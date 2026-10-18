import { assertEquals } from '@std/assert'
import {
  composeSourceDigest,
  parseComposeSourceInput,
  parseContainerNamingInput,
  parseDefaultServerIdInput,
  parseProjectOptions,
  resolveContainerNaming,
  mergeProjectDefaultServer,
  resolveEffectivePlacementServerId,
  splitProjectDefaultServer,
} from './project-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '11111111-1111-4111-8111-111111111111'
const SERVER_B = '22222222-2222-4222-8222-222222222222'

test('parseProjectOptions reads containerNaming and leaves the default server to its column', () => {
  const options = parseProjectOptions({
    containerNaming: 'custom',
    defaultServerId: SERVER_A,
    compose: { services: {} },
  })
  assertEquals(options, { containerNaming: 'custom' })
})

test('parseProjectOptions drops invalid containerNaming', () => {
  assertEquals(parseProjectOptions({ containerNaming: 'random' }), {})
  assertEquals(parseProjectOptions(null), {})
})

test('parseProjectOptions keeps a valid composeSource and drops a failed parse', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001'
  const seededDigest = await composeSourceDigest('services: {}\n')
  const composeSource = {
    sourceId,
    path: 'compose.yaml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest,
  }
  assertEquals(parseProjectOptions({ composeSource }).composeSource, composeSource)
  assertEquals(parseProjectOptions({ composeSource: { sourceId: '' } }), {})
})

test('parseContainerNamingInput accepts uuid and custom only', () => {
  assertEquals(parseContainerNamingInput('uuid'), { ok: true, value: 'uuid' })
  assertEquals(parseContainerNamingInput('custom'), { ok: true, value: 'custom' })
  assertEquals(parseContainerNamingInput('other'), { ok: false })
})

test('parseDefaultServerIdInput accepts UUID or null', () => {
  assertEquals(parseDefaultServerIdInput(SERVER_A), {
    ok: true,
    value: SERVER_A,
  })
  assertEquals(parseDefaultServerIdInput(null), { ok: true, value: null })
  assertEquals(parseDefaultServerIdInput('bad'), { ok: false })
})

test('resolveContainerNaming defaults to uuid', () => {
  assertEquals(resolveContainerNaming(undefined), 'uuid')
  assertEquals(resolveContainerNaming({}), 'uuid')
  assertEquals(resolveContainerNaming({ containerNaming: 'custom' }), 'custom')
})

test('effective placement inherits the project default server', () => {
  assertEquals(resolveEffectivePlacementServerId(null, SERVER_A), SERVER_A)
  assertEquals(resolveEffectivePlacementServerId(SERVER_B, SERVER_A), SERVER_B)
  assertEquals(resolveEffectivePlacementServerId(null, null), null)
  assertEquals(resolveEffectivePlacementServerId(null, undefined), null)
})

test('the default server moves between options and its column', () => {
  assertEquals(splitProjectDefaultServer({ compose: 1, defaultServerId: SERVER_A }), {
    options: { compose: 1 },
    defaultServerId: SERVER_A,
  })
  assertEquals(splitProjectDefaultServer({ compose: 1 }), {
    options: { compose: 1 },
    defaultServerId: null,
  })
  assertEquals(splitProjectDefaultServer(null), { options: null, defaultServerId: null })
  assertEquals(mergeProjectDefaultServer({ compose: 1 }, SERVER_A), {
    compose: 1,
    defaultServerId: SERVER_A,
  })
  assertEquals(mergeProjectDefaultServer({ compose: 1 }, null), { compose: 1 })
  assertEquals(mergeProjectDefaultServer(null, SERVER_A), { defaultServerId: SERVER_A })
})

test('parseComposeSourceInput rejects rather than silently dropping', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001'
  const base = {
    sourceId,
    path: 'docker-compose.yml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest: await composeSourceDigest('services:\n  web:\n    image: nginx\n'),
  }
  assertEquals(parseComposeSourceInput({ ...base, path: '../etc/passwd' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, path: '/etc/passwd' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, seededDigest: 'nope' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, seededCommitSha: 'zz' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, mode: 'live' }).ok, false)
  assertEquals(parseComposeSourceInput(base).ok, true)
  assertEquals(parseComposeSourceInput(null), { ok: true, value: null })
})

test('parseComposeSourceInput scopes the source to the organization', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001'
  const base = {
    sourceId,
    path: 'docker-compose.yml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest: await composeSourceDigest('services:\n  web:\n    image: nginx\n'),
  }
  assertEquals(parseComposeSourceInput(base, new Set(['other'])).ok, false)
  assertEquals(parseComposeSourceInput(base, new Set([base.sourceId])).ok, true)
})

test('parseComposeSourceInput rejects an empty sourceId and an oversized ref', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001'
  const base = {
    sourceId,
    path: 'docker-compose.yml',
    seededCommitSha: 'a'.repeat(40),
    seededDigest: await composeSourceDigest('services:\n  web:\n    image: nginx\n'),
  }
  assertEquals(parseComposeSourceInput({ ...base, sourceId: '' }).ok, false)
  assertEquals(parseComposeSourceInput({ ...base, ref: 'x'.repeat(256) }).ok, false)
})
