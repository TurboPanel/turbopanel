import { assertEquals } from '@std/assert'
import {
  buildPlatformComposeLayer,
  PROJECT_COMPOSE_FILENAME,
  transformUserLayerDocument,
  environmentComposeFilename,
  expandedOriginServiceNames,
  mergeComposeLayers,
  PLATFORM_COMPOSE_FILENAME,
  RUNTIME_COMPOSE_FILENAME,
  renderRuntimeComposeFiles,
  stripComposeTurbopanelExtensions,
} from './deploy-layers.ts'
import { applyVariablesToComposeDocument } from '../../lib/compose/apply-variables.ts'
import {
  composeDocumentToRuntimeYaml,
  emptyComposeDocument,
  type ComposeDocument,
} from '../../lib/compose/index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

test('environmentComposeFilename slugs name and falls back to id', () => {
  assertEquals(
    environmentComposeFilename({ id: 'env-uuid', name: 'Production' }),
    'docker-compose.production.yml',
  )
  assertEquals(
    environmentComposeFilename({ id: 'env-uuid', name: 'Staging Env!' }),
    'docker-compose.staging-env.yml',
  )
  assertEquals(
    environmentComposeFilename({ id: 'env-uuid', name: null }),
    'docker-compose.env-uuid.yml',
  )
  assertEquals(
    environmentComposeFilename({ id: 'env-uuid', name: '   ' }),
    'docker-compose.env-uuid.yml',
  )
  // Collision with platform basename → use id
  assertEquals(
    environmentComposeFilename({ id: 'env-uuid', name: 'turbopanel' }),
    'docker-compose.env-uuid.yml',
  )
})

test('expandedOriginServiceNames drops single-instance keys', () => {
  const names = expandedOriginServiceNames(
    new Map([
      ['web', ['web-1', 'web-2']],
      ['api', ['api']],
    ]),
  )
  assertEquals([...names], ['web'])
})

test('transformUserLayerDocument strips site and expanded origins', () => {
  // Host-native services are applied out-of-band, so they must not reach the
  // Docker document a layer emits.
  const project = doc({
    services: {
      web: { image: 'nginx' },
      site: {
        image: 'ignored',
        'x-turbopanel': { serviceKind: 'site', engine: 'nginx' },
      },
    },
  })
  const out = transformUserLayerDocument(
    project,
    new Set(['site', 'web']),
    new Map(),
    new Set(),
  )
  const services = isPlainObject(out.data.services)
    ? Object.keys(out.data.services as Record<string, unknown>)
    : []
  assertEquals(services, [])
})

test('transformUserLayerDocument renames volumes', () => {
  const project = doc({
    volumes: { data: null },
    services: { web: { image: 'nginx', volumes: ['data:/var'] } },
  })
  const out = transformUserLayerDocument(
    project,
    new Set(),
    new Map([['data', 'vol-uuid']]),
    new Set(),
  )
  assertEquals(
    Object.keys(out.data.volumes as Record<string, unknown>),
    ['vol-uuid'],
  )
})

test('transformUserLayerDocument prunes network keys the merged view dropped', () => {
  const project = doc({
    networks: { front: { external: true }, onlyTw: null },
    services: { web: { image: 'nginx', networks: ['front'] } },
  })
  const out = transformUserLayerDocument(
    project,
    new Set(),
    new Map(),
    new Set(['front']),
  )
  assertEquals(
    Object.keys(out.data.networks as Record<string, unknown>),
    ['front'],
  )
})

test('buildPlatformComposeLayer diffs injected keys and materializes expanded siblings', () => {
  const userMerged = doc({
    services: {
      web: {
        image: 'nginx',
        environment: { KEEP: 'yes', OLD: '1' },
      },
    },
  })
  const effective = doc({
    services: {
      web: {
        image: 'nginx',
        container_name: 'svc-uuid',
        environment: { KEEP: 'yes', OLD: '1', TURBOPANEL_PROJECT_ID: 'p1' },
        deploy: { resources: { limits: { cpus: '0.5' } } },
      },
      'web-2': {
        image: 'nginx',
        container_name: 'clone-uuid',
      },
    },
  })
  const platform = buildPlatformComposeLayer({ effective, userMerged })
  const services = platform.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.web?.container_name, 'svc-uuid')
  assertEquals(services.web?.environment, { TURBOPANEL_PROJECT_ID: 'p1' })
  assertEquals(services.web?.deploy, { resources: { limits: { cpus: '0.5' } } })
  assertEquals(services.web?.image, undefined)
  assertEquals(services['web-2'], {
    image: 'nginx',
    container_name: 'clone-uuid',
  })
})

test('renderRuntimeComposeFiles emits a single runtime compose.yaml', () => {
  const files = renderRuntimeComposeFiles(
    'services:\n  web:\n    image: nginx\n',
  )
  assertEquals(files.length, 1)
  assertEquals(files[0]!.filename, RUNTIME_COMPOSE_FILENAME)
  assertEquals(files[0]!.role, 'runtime')
  assertEquals(files[0]!.source, 'inline')
  assertEquals(files[0]!.content, 'services:\n  web:\n    image: nginx\n')
})

test('renderRuntimeComposeFiles falls back to empty services when content is blank', () => {
  const files = renderRuntimeComposeFiles('')
  assertEquals(files.length, 1)
  assertEquals(files[0]!.filename, RUNTIME_COMPOSE_FILENAME)
  assertEquals(files[0]!.role, 'runtime')
  assertEquals(files[0]!.source, 'inline')
  assertEquals(files[0]!.content, 'services: {}\n')
})

test('merge of user layers + platform equals effective after extension strip', () => {
  const project = doc({
    services: {
      web: { image: 'nginx:alpine' },
      site: {
        'x-turbopanel': { serviceKind: 'site', engine: 'nginx', root: 'public' },
      },
    },
    networks: {
      front: null,
      onlySite: null,
    },
  })
  const environment = doc({
    services: {
      web: { restart: 'unless-stopped' },
    },
  })
  const effective = doc({
    services: {
      web: {
        image: 'nginx:alpine',
        restart: 'unless-stopped',
        container_name: 'web-uuid',
        environment: { TURBOPANEL_ENV: 'x' },
      },
    },
    networks: {
      front: null,
    },
  })
  const removeNames = new Set(['site'])
  const renames = new Map()
  const keepNetworks = new Set(['front'])
  const userLayers = [
    {
      role: 'project' as const,
      filename: PROJECT_COMPOSE_FILENAME,
      document: transformUserLayerDocument(project, removeNames, renames, keepNetworks),
    },
    {
      role: 'environment' as const,
      filename: 'docker-compose.prod.yml',
      document: transformUserLayerDocument(environment, removeNames, renames, keepNetworks),
    },
  ]
  const userMerged = mergeComposeLayers(userLayers)
  const platform = buildPlatformComposeLayer({ effective, userMerged })
  const assembled = mergeComposeLayers([
    ...userLayers,
    { role: 'platform', filename: PLATFORM_COMPOSE_FILENAME, document: platform },
  ])
  assertEquals(
    stripComposeTurbopanelExtensions(assembled).data,
    stripComposeTurbopanelExtensions(effective).data,
  )
})

test(
  'list-form environment + platform inject: merged layers match the effective document',
  () => {
    // User compose keeps list-form environment; platform injects mapping keys.
    // The compiled runtime file is a single compose.yaml, so preview and deploy
    // share the merged effective document rather than a multi-file -f chain.
    const project = doc({
      services: {
        web: {
          image: 'nginx:alpine',
          environment: ['FOO=1', 'BAR:two', 'BAZ', 'KEEP=yes'],
        },
      },
    })
    const applied = applyVariablesToComposeDocument(project, {
      globalEntries: [{
        key: 'TURBOPANEL_PROJECT_ID',
        value: 'proj-1',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })
    if ('kind' in applied) {
      throw new TypeError(applied.message)
    }
    // Effective document after service-options would also set container_name;
    // include it so the platform layer has a scalar injection like real prepare.
    const effective: ComposeDocument = {
      version: 1,
      data: {
        services: {
          web: {
            ...((applied.document.data.services as Record<string, Record<string, unknown>>)
              .web!),
            container_name: 'web-uuid',
          },
        },
      },
      presentation: applied.document.presentation,
    }

    const noRemove = new Set<string>()
    const noRenames = new Map<string, string>()
    const noNetworks = new Set<string>()
    const userLayers = [
      {
        role: 'project' as const,
        filename: PROJECT_COMPOSE_FILENAME,
        document: transformUserLayerDocument(project, noRemove, noRenames, noNetworks),
      },
      {
        role: 'environment' as const,
        filename: 'docker-compose.production.yml',
        document: transformUserLayerDocument(
          emptyComposeDocument(),
          noRemove,
          noRenames,
          noNetworks,
        ),
      },
    ]
    const userMerged = mergeComposeLayers(userLayers)
    const platformDocument = buildPlatformComposeLayer({
      effective,
      userMerged,
    })
    const layers = [
      ...userLayers,
      {
        role: 'platform' as const,
        filename: PLATFORM_COMPOSE_FILENAME,
        document: platformDocument,
      },
    ]
    const assembled = mergeComposeLayers(layers)
    const runtimeFiles = renderRuntimeComposeFiles(
      composeDocumentToRuntimeYaml(assembled),
    )
    assertEquals(runtimeFiles.length, 1)
    assertEquals(runtimeFiles[0]!.filename, RUNTIME_COMPOSE_FILENAME)
    assertEquals(runtimeFiles[0]!.role, 'runtime')
    assertEquals(runtimeFiles[0]!.source, 'inline')
    assertEquals(
      stripComposeTurbopanelExtensions(assembled).data,
      stripComposeTurbopanelExtensions(effective).data,
    )

    const assembledWeb = (assembled.data.services as Record<string, Record<string, unknown>>)
      .web!
    assertEquals(assembledWeb.environment, {
      FOO: '1',
      BAR: 'two',
      BAZ: '',
      KEEP: 'yes',
      TURBOPANEL_PROJECT_ID: 'proj-1',
    })
    assertEquals(assembledWeb.container_name, 'web-uuid')
  },
)
