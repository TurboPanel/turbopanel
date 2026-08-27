/**
 * Host-free coverage for tag route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  buildTagPatchFields,
  MAX_TAGS_PER_ENTITY,
  parseTagColor,
  parseTagIds,
  parseTagParent,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const projectId = '11111111-1111-4111-8111-111111111111'
const serverId = '22222222-2222-4222-8222-222222222222'
const tagId = '33333333-3333-4333-8333-333333333333'

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectInvalidRequest(response: unknown): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected invalid request response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Invalid request' })
}

async function expectParentRequired(response: unknown): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected parent required response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), {
    error: 'Exactly one parent resource must be specified',
  })
}

test('parseTagParent accepts exactly one parent', () => {
  const parsed = parseTagParent(mockContext(), { projectId })
  if (parsed instanceof Response) {
    throw new TypeError('expected a parsed parent')
  }
  assertEquals(parsed, {
    column: 'projectId',
    id: projectId,
    entityKind: 'project',
  })
})

test('parseTagParent rejects a malformed parent id', async () => {
  await expectInvalidRequest(parseTagParent(mockContext(), { projectId: 'not-a-uuid' }))
})

test('parseTagParent rejects zero or two parents', async () => {
  await expectParentRequired(parseTagParent(mockContext(), {}))
  await expectParentRequired(parseTagParent(mockContext(), { projectId, serverId }))
})

test('parseTagColor accepts #abc / #AABBCC', () => {
  assertEquals(parseTagColor(mockContext(), '#abc'), '#abc')
  assertEquals(parseTagColor(mockContext(), '#AABBCC'), '#AABBCC')
  assertEquals(parseTagColor(mockContext(), null), null)
  assertEquals(parseTagColor(mockContext(), '  '), null)
})

test('parseTagColor rejects free text and over-length', async () => {
  await expectInvalidRequest(parseTagColor(mockContext(), 'red'))
  await expectInvalidRequest(parseTagColor(mockContext(), `#${'A'.repeat(40)}`))
})

test('parseTagIds dedupes and caps', async () => {
  const parsed = parseTagIds(mockContext(), [tagId, tagId, projectId])
  if (parsed instanceof Response) {
    throw new TypeError('expected parsed tag ids')
  }
  assertEquals(parsed, [tagId, projectId])

  const tooMany = Array.from({ length: MAX_TAGS_PER_ENTITY + 1 }, () => tagId)
  await expectInvalidRequest(parseTagIds(mockContext(), tooMany))
})

test('buildTagPatchFields rejects an empty patch', async () => {
  await expectInvalidRequest(buildTagPatchFields(mockContext(), {}))

  const patch = buildTagPatchFields(mockContext(), { name: 'prod' })
  if (patch instanceof Response) {
    throw new TypeError('expected a tag patch')
  }
  assertEquals(patch.name, 'prod')
})
