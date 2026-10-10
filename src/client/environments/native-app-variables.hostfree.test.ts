import { assertEquals } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  isApplyVariablesError,
} from '../../features/compose/apply-variables.ts'
import type { DeployVariableEntry } from '../../features/compose/apply-variables.ts'
import type { VariableScopeEntryMap } from '../../features/compose/apply-variables.ts'
import { splitNativeAppServices } from '../../features/compose/native-app.ts'
import { emptyComposeDocument } from '../../features/compose/types.ts'
import { parseEnvironmentDeployPayload } from '../../contracts/commands/schemas.ts'
import {
  mapResolvedScopesToDeployEntries,
  nativeAppServicesForDeploy,
  nativeAppVariableViews,
  nativeComposeServiceNames,
  resolveNativeAppVariables,
  tagVariableSources,
} from './deploy-prepare.ts'
import { buildNativeAppServicesForDeploy } from './deploy-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE_ID = '11111111-2222-3333-4444-555555555555'

function variable(overrides: Partial<DeployVariableEntry>): DeployVariableEntry {
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

/**
 * The order deploy-prepare runs them in: variables are applied to the merged
 * document first, and only then is the `node` service pulled out of it — so the
 * Compose `environment:` the variables module built leaves with the service.
 */
function prepareNativeApp(
  entries: DeployVariableEntry[],
  environment?: Record<string, string>,
  perServiceScopes?: Map<string, VariableScopeEntryMap>
) {
  const doc = emptyComposeDocument()
  doc.data.services = {
    web: {
      ...(environment ? { environment } : {}),
      'x-turbopanel': {
        serviceKind: 'node',
        source: { sourceId: SOURCE_ID },
        appMode: 'production',
      },
    },
  }
  const applied = applyVariablesToComposeDocument(doc, {
    globalEntries: entries,
    perServiceEntries: new Map(),
    ...(perServiceScopes ? { perServiceScopes } : {}),
    nativeServiceNames: nativeComposeServiceNames(doc),
  })
  if (isApplyVariablesError(applied)) throw new TypeError(applied.message)
  const services = applied.document.data.services as Record<string, unknown>
  const split = splitNativeAppServices(services)
  const variables = resolveNativeAppVariables(split.apps, applied)
  const prepared = nativeAppServicesForDeploy(
    split.apps,
    [
      {
        serviceId: '00000000-0000-4000-8000-0000000000a1',
        composeServiceName: 'web',
        kind: 'node',
        clones: ['web'],
        slots: [],
        containers: [],
        hostings: [],
      },
    ],
    {},
    {},
    new Map(),
    variables
  )
  return { applied, split, prepared, variables }
}

test('a Node app used to lose its variables with its compose service; now they ride its payload', () => {
  const { split, prepared } = prepareNativeApp(
    [
      variable({ key: 'API_URL', value: 'https://example.test', source: 'project' }),
      variable({
        key: 'DB_SECRET',
        isSecret: true,
        value: 'tpsecret.v1.sealed',
        source: 'organization',
      }),
    ],
    { DB_PASSWORD: '{$DB_SECRET}' }
  )

  // Before: nothing about the variables survived the split.
  assertEquals(JSON.stringify(split.apps).includes('API_URL'), false)

  assertEquals(prepared[0]?.variables, [
    { name: 'API_URL', value: 'https://example.test' },
    { name: 'DB_PASSWORD', secretKey: 'DB_SECRET' },
  ])
})

test('the wire carries no secret value, and the sealed one rides variableMaterial', () => {
  const { applied, prepared } = prepareNativeApp(
    [variable({ key: 'DB_SECRET', isSecret: true, value: 'plaintext-secret' })],
    { DB_PASSWORD: '{$DB_SECRET}' }
  )
  assertEquals(JSON.stringify(prepared).includes('plaintext-secret'), false)
  // The pointer names the same (service, key) the sealed material is filed under.
  assertEquals(prepared[0]?.variables, [{ name: 'DB_PASSWORD', secretKey: 'DB_SECRET' }])
  assertEquals(
    applied.secretMaterial.map((entry) => [entry.composeServiceName, entry.key]),
    [['web', 'DB_SECRET']]
  )
})

test('an app with no variables carries no variables field, so its payload is unchanged', () => {
  const { prepared } = prepareNativeApp([])
  assertEquals('variables' in (prepared[0] ?? {}), false)
})

test('the list people read shows where each name came from and hides secret values', () => {
  const { variables, split } = prepareNativeApp(
    [
      variable({ key: 'API_URL', value: 'https://example.test', source: 'project' }),
      variable({ key: 'PORT', value: '1', source: 'environment' }),
      variable({
        key: 'DB_SECRET',
        isSecret: true,
        value: 'plaintext-secret',
        source: 'organization',
      }),
    ],
    { DB_PASSWORD: '{$DB_SECRET}' }
  )
  const view = variables.get('web')?.view ?? []
  assertEquals(
    view.map((row) => [row.name, row.source, row.value, row.delivered]),
    [
      ['HOST', 'platform', '127.0.0.1', true],
      ['HOSTNAME', 'platform', '127.0.0.1', true],
      ['NODE_ENV', 'platform', 'production', true],
      ['PORT', 'platform', String(split.apps[0]?.listenPort), true],
      ['API_URL', 'project', 'https://example.test', true],
      ['DB_PASSWORD', 'organization', null, true],
      // Set on the service but never reaches the process: the platform owns it.
      ['PORT', 'environment', '1', false],
    ]
  )
  assertEquals(JSON.stringify(view).includes('plaintext-secret'), false)
})

test('the assembled payload round-trips through the contract parser unchanged', () => {
  const { prepared } = prepareNativeApp(
    [variable({ key: 'API_URL', value: 'https://example.test' })],
    {}
  )
  const wire = buildNativeAppServicesForDeploy(prepared, [], [])
  const parsed = parseEnvironmentDeployPayload({
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\n' }],
    hostings: [],
    nativeAppServices: wire,
  })
  assertEquals(parsed.nativeAppServices?.[0]?.variables, [
    { name: 'API_URL', value: 'https://example.test' },
  ])
})

test('a secret set on the app arrives on its own; one set higher up waits for a reference', () => {
  const { prepared, applied, variables } = prepareNativeApp([
    variable({ key: 'APP_KEY', isSecret: true, value: 'sealed', source: 'service' }),
    variable({ key: 'ORG_KEY', isSecret: true, value: 'sealed', source: 'organization' }),
  ])
  assertEquals(prepared[0]?.variables, [{ name: 'APP_KEY', secretKey: 'APP_KEY' }])
  // The one that does arrive has sealed material to open it with; the other has none.
  assertEquals(
    applied.secretMaterial.map((entry) => [entry.composeServiceName, entry.key]),
    [['web', 'APP_KEY']]
  )
  const waiting = variables.get('web')?.view.find((row) => row.name === 'ORG_KEY')
  assertEquals(waiting, {
    name: 'ORG_KEY',
    source: 'organization',
    isSecret: true,
    value: null,
    delivered: false,
    reason: 'not_referenced',
  })
})

test('a scoped reference is labelled with the scope it was read from', () => {
  const scoped = mapResolvedScopesToDeployEntries(
    {
      project: new Map([
        [
          'REGION',
          { value: 'au', isSecret: false, isLiteral: false, forBuild: false, forRuntime: false },
        ],
      ]),
      server: new Map([
        [
          'TOKEN',
          { value: 'sealed', isSecret: true, isLiteral: false, forBuild: false, forRuntime: false },
        ],
      ]),
    },
    undefined
  )
  return scoped.then((scopes) => {
    assertEquals(scopes.project?.get('REGION')?.source, 'project')
    assertEquals(scopes.server?.get('TOKEN')?.source, 'server')
    const { variables } = prepareNativeApp(
      [],
      { REGION: '{$project.REGION}' },
      new Map([['web', scopes]])
    )
    assertEquals(
      variables.get('web')?.view.find((row) => row.name === 'REGION'),
      { name: 'REGION', source: 'project', isSecret: false, value: 'au', delivered: true }
    )
  })
})

test('effective entries are labelled from the scope maps they were merged from', () => {
  const entry = { value: 'v', isSecret: false, isLiteral: false, forBuild: false, forRuntime: true }
  const tagged = tagVariableSources(
    [
      variable({ key: 'A' }),
      variable({ key: 'B', bindingId: 'binding-1' }),
      variable({ key: 'C' }),
    ],
    {
      service: new Map([['A', entry]]),
      organization: new Map([
        ['A', entry],
        ['C', entry],
      ]),
    }
  )
  assertEquals(
    tagged.map((row) => [row.key, row.source]),
    [
      ['A', 'service'],
      ['B', 'binding'],
      ['C', 'organization'],
    ]
  )
})

test('the preview rows are built per app from the same lists the wire uses', () => {
  const { variables, split } = prepareNativeApp([
    variable({ key: 'ORG_KEY', isSecret: true, source: 'organization' }),
    variable({ key: 'API_URL', value: 'https://example.test', source: 'project' }),
  ])
  const rows = nativeAppVariableViews(split.apps, variables)
  assertEquals(rows.length, 1)
  assertEquals(rows[0]?.composeServiceName, 'web')
  // The unreferenced secret is listed (without a value) by the production path.
  assertEquals(
    rows[0]?.variables.filter((row) => row.reason === 'not_referenced').map((row) => row.name),
    ['ORG_KEY']
  )
})
