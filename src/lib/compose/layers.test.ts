import { assertEquals } from '@std/assert'
import { stripComposeTurbopanelExtensions } from './extensions.ts'
import {
  collectTraditionalWebServiceNames,
  mergeComposeLayers,
  renameComposeVolumesInLayer,
  stripComposePlacementFromLayer,
  stripTraditionalWebServicesFromLayer,
  type ComposeLayer,
} from './layers.ts'
import { TURBOPANEL_EXTENSION_KEY } from './placement.ts'
import {
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
  unwrapComposeTag,
} from './tags.ts'
import type { ComposeDocument } from './types.ts'
import { emptyComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

function layer(
  role: ComposeLayer['role'],
  filename: string,
  data: Record<string, unknown>,
): ComposeLayer {
  return { role, filename, document: doc(data) }
}

test('mergeComposeLayers ordering: later scalars win, sequences append across three layers', () => {
  const layers: ComposeLayer[] = [
    layer('project', 'compose.yml', {
      services: { web: { image: 'a', ports: ['80:80'] } },
    }),
    layer('environment', 'compose.env.yml', {
      services: { web: { ports: ['443:443'] } },
    }),
    layer('platform', 'compose.platform.yml', {
      services: { web: { image: 'c', ports: ['8080:8080'] } },
    }),
  ]
  const merged = mergeComposeLayers(layers)
  const web = (merged.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(web.image, 'c')
  assertEquals(web.ports, ['80:80', '443:443', '8080:8080'])
})

test('mergeComposeLayers empty list returns empty document', () => {
  assertEquals(mergeComposeLayers([]), emptyComposeDocument())
})

test('stripTraditionalWebServicesFromLayer uses merged-view name set', () => {
  const project = doc({
    services: {
      site: {
        'x-turbopanel': {
          serviceKind: 'traditional-web',
          engine: 'nginx',
        },
      },
      api: { image: 'node:22' },
    },
  })
  // Environment only overrides ports — no serviceKind marker (half-service).
  const environment = doc({
    services: {
      site: { ports: ['8080:80'] },
    },
  })
  const merged = mergeComposeLayers([
    { role: 'project', filename: 'compose.yml', document: project },
    { role: 'environment', filename: 'compose.env.yml', document: environment },
  ])
  const names = collectTraditionalWebServiceNames(merged)
  assertEquals([...names], ['site'])

  const strippedEnv = stripTraditionalWebServicesFromLayer(environment, names)
  const envServices = strippedEnv.data.services as Record<string, unknown>
  assertEquals('site' in envServices, false)

  // Self-detection alone on environment would miss site (no marker).
  const selfOnly = stripTraditionalWebServicesFromLayer(environment)
  assertEquals(
    'site' in (selfOnly.data.services as Record<string, unknown>),
    true,
  )
})

test('renameComposeVolumesInLayer applies renames on one layer', () => {
  const document = doc({
    volumes: { data: null },
    services: {
      web: { image: 'nginx', volumes: ['data:/var/lib/data'] },
    },
  })
  const renames = new Map([['data', 'vol-uuid']])
  const next = renameComposeVolumesInLayer(document, renames)
  assertEquals(Object.keys(next.data.volumes as object), ['vol-uuid'])
  assertEquals(
    (next.data.services as Record<string, Record<string, unknown>>).web.volumes,
    ['vol-uuid:/var/lib/data'],
  )
})

test('stripComposePlacementFromLayer + stripComposeTurbopanelExtensions', () => {
  const document = doc({
    [TURBOPANEL_EXTENSION_KEY]: {
      placement: { server_id: '01989d42-9adb-7e65-bc2e-f38792c53691' },
      other: true,
    },
    services: {
      web: {
        image: 'nginx',
        'x-turbopanel': { description: 'hi' },
      },
    },
  })
  const noPlacement = stripComposePlacementFromLayer(document)
  const ext = noPlacement.data[TURBOPANEL_EXTENSION_KEY] as Record<string, unknown>
  assertEquals('placement' in ext, false)
  assertEquals(ext.other, true)

  const stripped = stripComposeTurbopanelExtensions(document)
  assertEquals(TURBOPANEL_EXTENSION_KEY in stripped.data, false)
  const web = (stripped.data.services as Record<string, Record<string, unknown>>).web
  assertEquals('x-turbopanel' in web, false)
  assertEquals(web.image, 'nginx')
})

test('no per-layer network prune export — prune remains merged-view only', () => {
  // Network prune must not be applied per layer: a later layer may still
  // reference a network only declared earlier. Surface stays on the index
  // re-export of pruneUnreferencedComposeNetworks for merged documents.
  const layerDoc = doc({
    networks: { frontend: null, backend: null },
    services: {
      web: { image: 'nginx', networks: ['frontend'] },
    },
  })
  // after strip of a hypothetical unused service, networks stay intact on the layer
  const next = stripTraditionalWebServicesFromLayer(layerDoc, new Set())
  assertEquals(Object.keys(next.data.networks as object).sort(), [
    'backend',
    'frontend',
  ])
})

test('stripTraditionalWebServicesFromLayer looks through tagged services', () => {
  const document = doc({
    services: makeComposeTag('override', {
      site: {
        'x-turbopanel': {
          serviceKind: 'traditional-web',
          engine: 'nginx',
        },
      },
      api: { image: 'node:22' },
    }),
  })
  const next = stripTraditionalWebServicesFromLayer(
    document,
    new Set(['site']),
  )
  assertEquals(composeTagOf(next.data.services), 'override')
  const services = unwrapComposeTag(next.data.services) as Record<string, unknown>
  assertEquals('site' in services, false)
  assertEquals((services.api as { image: string }).image, 'node:22')
})

test('stripTraditionalWebServicesFromLayer self-detects tagged service bodies', () => {
  const document = doc({
    services: {
      site: makeComposeTag('override', {
        'x-turbopanel': {
          serviceKind: 'traditional-web',
          engine: 'nginx',
        },
      }),
      api: { image: 'node:22' },
    },
  })
  const next = stripTraditionalWebServicesFromLayer(document)
  const services = next.data.services as Record<string, unknown>
  assertEquals('site' in services, false)
  assertEquals((services.api as { image: string }).image, 'node:22')
})

test('renameComposeVolumesInLayer rewrites !override volumes payload', () => {
  const document = doc({
    volumes: { data: null },
    services: {
      web: {
        image: 'nginx',
        volumes: makeComposeTag('override', ['data:/data']),
      },
    },
  })
  const next = renameComposeVolumesInLayer(
    document,
    new Map([['data', 'vol-uuid']]),
  )
  const volumes = (next.data.services as Record<string, Record<string, unknown>>)
    .web.volumes
  assertEquals(isComposeTaggedValue(volumes), true)
  assertEquals(unwrapComposeTag(volumes), ['vol-uuid:/data'])
})

test('stripComposePlacementFromLayer looks through tagged extension', () => {
  const document = doc({
    [TURBOPANEL_EXTENSION_KEY]: makeComposeTag('override', {
      placement: { server_id: '01989d42-9adb-7e65-bc2e-f38792c53691' },
      other: true,
    }),
  })
  const next = stripComposePlacementFromLayer(document)
  const ext = next.data[TURBOPANEL_EXTENSION_KEY]
  assertEquals(composeTagOf(ext), 'override')
  assertEquals(unwrapComposeTag(ext), { other: true })
})

test('stripComposeTurbopanelExtensions looks through tagged service bodies', () => {
  const document = doc({
    services: {
      web: makeComposeTag('override', {
        image: 'nginx',
        'x-turbopanel': { description: 'hidden' },
      }),
    },
  })
  const stripped = stripComposeTurbopanelExtensions(document)
  const web = (stripped.data.services as Record<string, unknown>).web
  assertEquals(composeTagOf(web), 'override')
  assertEquals(unwrapComposeTag(web), { image: 'nginx' })
})
