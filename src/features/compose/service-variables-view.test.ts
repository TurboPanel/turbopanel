import { assertEquals } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  isApplyVariablesError,
} from './apply-variables.ts'
import { buildServiceVariablesViews, type ServiceVariableView } from './service-variables-view.ts'
import { emptyComposeDocument } from './types.ts'

const test = Deno.test.bind(Deno)

function entry(overrides: Partial<DeployVariableEntry>): DeployVariableEntry {
  return {
    key: 'K',
    value: 'v',
    isSecret: false,
    isLiteral: false,
    forBuild: false,
    forRuntime: true,
    ...overrides,
  }
}

/** Apply `entries` to one container service and read back the preview's list. */
function viewOf(
  service: Record<string, unknown>,
  entries: DeployVariableEntry[],
  sourceBuilt = new Set<string>()
): ServiceVariableView[] {
  const doc = emptyComposeDocument()
  doc.data.services = { web: service }
  const applied = applyVariablesToComposeDocument(doc, {
    globalEntries: entries,
    perServiceEntries: new Map(),
  })
  if (isApplyVariablesError(applied)) throw new TypeError(applied.message)
  return buildServiceVariablesViews(applied, sourceBuilt)[0]?.variables ?? []
}

function find(list: ServiceVariableView[], name: string, forBuild: boolean) {
  return list.find((v) => v.name === name && v.forBuild === forBuild)
}

test('one key feeding two names lists both, and the automatic add wins over a mapping', () => {
  const variables = viewOf(
    { image: 'x', environment: { NODE_OPTIONS: '{$OPTS}', FOO: '{$BAR}' } },
    [
      entry({ key: 'OPTS', value: 'o' }),
      entry({ key: 'BAR', value: 'bar' }),
      entry({ key: 'FOO', value: 'foo' }),
    ]
  )
  const byName = Object.fromEntries(variables.map((v) => [v.name, v.value]))
  assertEquals(byName.NODE_OPTIONS, 'o')
  assertEquals(byName.OPTS, 'o')
  assertEquals(byName.BAR, 'bar')
  assertEquals(byName.FOO, 'foo')
})

test('a build mapping does not leak its flag onto a runtime name', () => {
  const variables = viewOf(
    {
      image: 'x',
      build: { context: '.', args: { X: '{$OPTS}' } },
      environment: { NODE_OPTIONS: '{$OPTS}' },
    },
    [entry({ key: 'OPTS', value: 'o', forBuild: true, forRuntime: true })]
  )
  assertEquals(find(variables, 'X', true)?.value, 'o')
  assertEquals(find(variables, 'X', false), undefined)
  assertEquals(find(variables, 'NODE_OPTIONS', false)?.value, 'o')
  assertEquals(find(variables, 'NODE_OPTIONS', true), undefined)
})

test('a renamed build-only secret is listed under the name the build reads it by', () => {
  const variables = viewOf(
    { image: 'x', build: { context: '.', args: { REGISTRY_AUTH: '{$NPM_TOKEN}' } } },
    [
      entry({
        key: 'NPM_TOKEN',
        value: 's3cret',
        isSecret: true,
        forBuild: true,
        forRuntime: false,
      }),
    ]
  )
  const row = variables.find((v) => v.isSecret)
  assertEquals(row?.name, 'REGISTRY_AUTH')
  assertEquals(row?.forBuild, true)
  assertEquals(row?.forRuntime, false)
  assertEquals(row?.value, null)
  assertEquals(
    variables.some((v) => v.name === 'NPM_TOKEN'),
    false
  )
  assertEquals(JSON.stringify(variables).includes('s3cret'), false)
})

test('a variable used while building and running is one row with both flags', () => {
  const variables = viewOf({ image: 'x' }, [
    entry({ key: 'SHARED', value: '1', forBuild: true, forRuntime: true }),
  ])
  assertEquals(variables.length, 1)
  assertEquals(variables[0].forBuild && variables[0].forRuntime, true)
})

test('a name the host refuses in a source build is flagged, only for source builds', () => {
  const entries = [entry({ key: 'PATH', value: '/x', forBuild: true, forRuntime: false })]
  const built = viewOf({ image: 'x' }, entries, new Set(['web']))
  assertEquals(find(built, 'PATH', true)?.droppedFromBuild, true)
  const container = viewOf({ image: 'x' }, entries)
  assertEquals(find(container, 'PATH', true)?.droppedFromBuild, undefined)
})

test('one name that means different things in each lane stays two rows', () => {
  const views = buildServiceVariablesViews({
    runtimeAssignments: new Map([
      ['web', [{ name: 'X', key: 'A', isSecret: false, value: 'run', source: 'project' }]],
    ]),
    buildAssignments: new Map([
      ['web', [{ name: 'X', key: 'B', value: 'build', source: 'project' }]],
    ]),
    secretPlan: [],
  })
  assertEquals(
    views[0].variables.map((v) => [v.name, v.value, v.forBuild, v.forRuntime]),
    [
      ['X', 'run', false, true],
      ['X', 'build', true, false],
    ]
  )
})

test('never carries a secret value and skips services with nothing', () => {
  const views = buildServiceVariablesViews({
    runtimeAssignments: new Map([
      ['a', [{ name: 'S', key: 'S', isSecret: true, value: null, source: 'project' }]],
      ['b', []],
    ]),
    buildAssignments: new Map(),
    secretPlan: [],
  })
  assertEquals(
    views.map((v) => v.composeServiceName),
    ['a']
  )
  assertEquals(views[0].variables[0].value, null)
})
