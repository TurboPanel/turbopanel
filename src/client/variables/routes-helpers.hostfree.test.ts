/**
 * Host-free coverage for variable route pure helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  buildInsertValues,
  isPostgresUniqueViolation,
  isVariableKeyUniqueViolation,
  PARENT_BODY_FIELDS,
  parseOptionalStringValue,
  parseResolvedVariablesQuery,
  parseVariableParent,
  patchHasOnlyUpdatedAt,
  switchingSecretRequiresValue,
  validateVariableKeyValue,
  variableKeyUniqueConflictMessage,
  VARIABLE_KEY_RE,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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

test('VARIABLE_KEY_RE accepts identifiers and rejects empty keys', () => {
  assertEquals(VARIABLE_KEY_RE.test('APP_ENV'), true)
  assertEquals(VARIABLE_KEY_RE.test('_PRIVATE'), true)
  assertEquals(VARIABLE_KEY_RE.test(''), false)
  assertEquals(VARIABLE_KEY_RE.test('9BAD'), false)
})

test('isPostgresUniqueViolation detects 23505 only', () => {
  assertEquals(isPostgresUniqueViolation({ code: '23505' }), true)
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)
  assertEquals(isPostgresUniqueViolation('23505'), false)
  assertEquals(isPostgresUniqueViolation(null), false)
})

test('isVariableKeyUniqueViolation matches each partial unique index name', () => {
  for (const indexName of [
    'uniq_var_org',
    'uniq_var_workspace',
    'uniq_var_project',
    'uniq_var_environment',
    'uniq_var_service',
    'uniq_var_hosting',
    'uniq_var_server',
  ]) {
    const err = Object.assign(
      new Error(`duplicate key value violates unique constraint "${indexName}"`),
      { code: '23505' },
    )
    assertEquals(isVariableKeyUniqueViolation(err), true)
  }
  assertEquals(
    isVariableKeyUniqueViolation(Object.assign(new Error('other'), { code: '23505' })),
    false,
  )
})

test('parseVariableParent accepts every parent body field', async () => {
  const c = mockContext()
  for (const { bodyKey, column, entityKind } of PARENT_BODY_FIELDS) {
    assertEquals(parseVariableParent(c, { [bodyKey]: `${entityKind}-id` }), {
      column,
      id: `${entityKind}-id`,
      entityKind,
    })
  }
})

test('parseVariableParent rejects multiple parents and invalid ids', async () => {
  const c = mockContext()
  await expectParentRequired(
    parseVariableParent(c, { projectId: 'p1', environmentId: 'e1' }),
  )
  await expectParentRequired(parseVariableParent(c, { projectId: '' }))
  await expectInvalidRequest(parseVariableParent(c, { projectId: 42 }))
})

test('parseOptionalStringValue rejects non-string values', async () => {
  const c = mockContext()
  await expectInvalidRequest(parseOptionalStringValue(c, 12))
})

test('buildInsertValues pins server parent column', () => {
  const values = buildInsertValues(
    { column: 'serverId', id: 'srv-1', entityKind: 'server' },
    {
      key: 'HOST',
      value: 'panel',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
      description: 'host override',
    },
  )
  assertEquals(values.serverId, 'srv-1')
  assertEquals(values.hostingId, null)
  assertEquals(values.description, 'host override')
})

test('parseResolvedVariablesQuery requires exactly one scope', () => {
  assertEquals(
    parseResolvedVariablesQuery({
      serviceId: undefined,
      environmentId: undefined,
      hostingId: undefined,
    }).ok,
    false,
  )
  assertEquals(
    parseResolvedVariablesQuery({
      serviceId: 's1',
      environmentId: 'e1',
      hostingId: undefined,
    }).ok,
    false,
  )
  assertEquals(
    parseResolvedVariablesQuery({
      serviceId: undefined,
      environmentId: undefined,
      hostingId: 'h1',
    }),
    { ok: true, query: { kind: 'hosting', id: 'h1' } },
  )
  assertEquals(
    parseResolvedVariablesQuery({
      serviceId: 's1',
      environmentId: undefined,
      hostingId: undefined,
    }),
    { ok: true, query: { kind: 'service', id: 's1' } },
  )
  assertEquals(
    parseResolvedVariablesQuery({
      serviceId: undefined,
      environmentId: 'e1',
      hostingId: undefined,
    }),
    { ok: true, query: { kind: 'environment', id: 'e1' } },
  )
})

test('validateVariableKeyValue and patch helpers', () => {
  assertEquals(validateVariableKeyValue('APP_ENV'), { ok: true, key: 'APP_ENV' })
  assertEquals(validateVariableKeyValue('9BAD').ok, false)
  assertEquals(patchHasOnlyUpdatedAt({ updatedAt: 'x' }), true)
  assertEquals(patchHasOnlyUpdatedAt({ updatedAt: 'x', key: 'A' }), false)
  assertEquals(switchingSecretRequiresValue(false, true, false), true)
  assertEquals(switchingSecretRequiresValue(false, true, true), false)
  assertEquals(variableKeyUniqueConflictMessage(), 'A variable with this key already exists in this scope')
})
