import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  buildInsertValues,
  hasImmutableParentChange,
  isVariableKeyUniqueViolation,
  parseIsSecret,
  parseOptionalBoolean,
  parseOptionalDescription,
  parseOptionalStringValue,
  parseVariableKey,
  parseVariableParent,
  resolvePatchIsSecret,
  serializeResolvedVariables,
  serializeVariable,
  trimVariableValueOnWrite,
  BINDING_OWNED_VARIABLE_ERROR,
  BINDING_KEY_CONFLICT_ERROR,
  type VariableRow,
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

function baseRow(overrides?: Partial<VariableRow>): VariableRow {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    organizationId: null,
    workspaceId: null,
    projectId: '00000000-0000-4000-8000-000000000002',
    environmentId: null,
    serviceId: null,
    hostingId: null,
    serverId: null,
    bindingId: null,
    key: 'APP_ENV',
    value: 'production',
    isSecret: false,
    isLiteral: false,
    forBuild: false,
    forRuntime: true,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('serializeVariable masks secret values', () => {
  const plain = serializeVariable(baseRow())
  assertEquals(plain.value, 'production')
  assertEquals(plain.isSecret, false)

  const secret = serializeVariable(baseRow({ isSecret: true, value: 'sealed' }))
  assertEquals(secret.value, null)
  assertEquals(secret.isSecret, true)
})

test('serializeResolvedVariables mirrors secret masking', () => {
  const serialized = serializeResolvedVariables(new Map([
    ['OPEN', {
      value: '1',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
    }],
    ['TOKEN', {
      value: 'secret',
      isSecret: true,
      isLiteral: true,
      forBuild: true,
      forRuntime: true,
    }],
  ]))
  assertEquals(serialized.OPEN?.value, '1')
  assertEquals(serialized.TOKEN?.value, null)
  assertEquals(serialized.TOKEN?.isLiteral, true)
})

test('parseVariableKey validates identifier shape', async () => {
  const c = mockContext()
  assertEquals(parseVariableKey(c, 'VALID_1'), 'VALID_1')
  await expectInvalidRequest(parseVariableKey(c, '1BAD'))
})

test('parseIsSecret defaults false and rejects non-boolean', async () => {
  const c = mockContext()
  assertEquals(parseIsSecret(c, {}), false)
  assertEquals(parseIsSecret(c, { isSecret: null }), false)
  assertEquals(parseIsSecret(c, { isSecret: true }), true)
  await expectInvalidRequest(parseIsSecret(c, { isSecret: 'yes' }))
})

test('parseOptionalBoolean and description enforce types and length', async () => {
  const c = mockContext()
  assertEquals(parseOptionalBoolean(c, undefined), undefined)
  assertEquals(parseOptionalBoolean(c, true), true)
  await expectInvalidRequest(parseOptionalBoolean(c, 'nope'))
  assertEquals(parseOptionalDescription(c, 'ok'), 'ok')
  assertEquals(parseOptionalDescription(c, null), null)
  await expectInvalidRequest(parseOptionalDescription(c, 'x'.repeat(256)))
})

test('parseOptionalStringValue accepts null and strings', () => {
  const c = mockContext()
  assertEquals(parseOptionalStringValue(c, undefined), undefined)
  assertEquals(parseOptionalStringValue(c, null), null)
  assertEquals(parseOptionalStringValue(c, ' value '), ' value ')
})

test('trimVariableValueOnWrite trims whitespace', () => {
  assertEquals(trimVariableValueOnWrite('  hello  '), 'hello')
})

test('parseVariableParent requires a single parent field', async () => {
  const c = mockContext()
  assertEquals(parseVariableParent(c, { projectId: 'p1' }), {
    column: 'projectId',
    id: 'p1',
    entityKind: 'project',
  })
  await expectParentRequired(parseVariableParent(c, {}))
})

test('buildInsertValues pins parent column only', () => {
  const values = buildInsertValues(
    { column: 'environmentId', id: 'env-1', entityKind: 'environment' },
    {
      key: 'K',
      value: 'v',
      isSecret: false,
      isLiteral: false,
      forBuild: false,
      forRuntime: true,
      description: null,
    },
  )
  assertEquals(values.environmentId, 'env-1')
  assertEquals(values.projectId, null)
  assertEquals(values.key, 'K')
})

test('hasImmutableParentChange detects parent id patches', () => {
  assertEquals(hasImmutableParentChange({ name: 'x' }), false)
  assertEquals(hasImmutableParentChange({ serviceId: 's1' }), true)
})

test('resolvePatchIsSecret toggles secret flag safely', async () => {
  const c = mockContext()
  assertEquals(resolvePatchIsSecret(c, {}, true), {
    toggled: false,
    nextIsSecret: true,
  })
  assertEquals(resolvePatchIsSecret(c, { isSecret: false }, true), {
    toggled: true,
    nextIsSecret: false,
  })
  await expectInvalidRequest(resolvePatchIsSecret(c, { isSecret: 'nope' }, true))
})

test('isVariableKeyUniqueViolation matches partial unique indexes', () => {
  const match = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_var_project"'),
    { code: '23505' },
  )
  assertEquals(isVariableKeyUniqueViolation(match), true)
  assertEquals(isVariableKeyUniqueViolation({ code: '23505' }), false)
})

test('binding ownership error codes are stable', () => {
  assertEquals(BINDING_OWNED_VARIABLE_ERROR, 'binding_owned_variable')
  assertEquals(BINDING_KEY_CONFLICT_ERROR, 'binding_key_conflict')
})

test('serializeVariable includes bindingId and redacts secrets', () => {
  const row: VariableRow = {
    id: 'v1',
    organizationId: null,
    workspaceId: null,
    projectId: null,
    environmentId: null,
    serviceId: 's1',
    hostingId: null,
    serverId: null,
    bindingId: 'b1',
    key: 'DATABASE_URL',
    value: 'tpsecret.v1.x',
    isSecret: true,
    isLiteral: true,
    forBuild: false,
    forRuntime: true,
    description: null,
    createdAt: 't0',
    updatedAt: 't1',
  }
  const serialized = serializeVariable(row)
  assertEquals(serialized.bindingId, 'b1')
  assertEquals(serialized.value, null)
})
