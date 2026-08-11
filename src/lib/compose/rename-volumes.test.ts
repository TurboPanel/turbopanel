import { assertEquals } from 'jsr:@std/assert'
import { renameComposeVolumes } from './rename-volumes.ts'
import {
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
  unwrapComposeTag,
} from './tags.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('renameComposeVolumes rewrites top-level keys and short/long refs', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          volumes: [
            'cache:/var/cache',
            { type: 'volume', source: 'data', target: '/data' },
            './local:/app',
          ],
        },
      },
      volumes: {
        cache: {},
        data: { driver: 'local' },
      },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }

  const renames = new Map([
    ['cache', '01936b3e-aaaa-bbbb-cccc-123456789abc'],
    ['data', '01936b3e-dddd-eeee-ffff-123456789abc'],
  ])
  const result = renameComposeVolumes(document, renames)
  const volumes = result.data.volumes as Record<string, unknown>
  const web = (result.data.services as Record<string, Record<string, unknown>>).web!

  assertEquals(Object.keys(volumes).sort((a, b) => a.localeCompare(b)), [
    '01936b3e-aaaa-bbbb-cccc-123456789abc',
    '01936b3e-dddd-eeee-ffff-123456789abc',
  ])
  assertEquals(web.volumes, [
    '01936b3e-aaaa-bbbb-cccc-123456789abc:/var/cache',
    {
      type: 'volume',
      source: '01936b3e-dddd-eeee-ffff-123456789abc',
      target: '/data',
    },
    './local:/app',
  ])
})

test('renameComposeVolumes leaves bind mounts and unlisted keys alone', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          volumes: ['/host/path:/data', '../rel:/rel', 'keep:/keep'],
        },
      },
      volumes: { keep: {}, other: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const result = renameComposeVolumes(document, new Map([['missing', 'x']]))
  assertEquals(result.data.volumes, { keep: {}, other: {} })
  assertEquals(
    (result.data.services as Record<string, Record<string, unknown>>).web!.volumes,
    ['/host/path:/data', '../rel:/rel', 'keep:/keep'],
  )
})

test('renameComposeVolumes is a no-op for empty rename map', () => {
  const document: ComposeDocument = {
    version: 1,
    data: { services: { web: { volumes: ['data:/data'] } }, volumes: { data: {} } },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  assertEquals(renameComposeVolumes(document, new Map()), document)
})

test('renameComposeVolumes leaves tilde bind mounts unchanged', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: { web: { volumes: ['~/data:/data', 'cache:/cache'] } },
      volumes: { cache: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const renamed = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const result = renameComposeVolumes(document, new Map([['cache', renamed]]))
  const volumes = (result.data.services as Record<string, Record<string, unknown>>).web!
    .volumes as string[]
  assertEquals(volumes[0], '~/data:/data')
  assertEquals(volumes[1], `${renamed}:/cache`)
})

test('renameComposeVolumes leaves malformed short refs unchanged', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: { web: { volumes: [':/data', 'cache:/cache'] } },
      volumes: { cache: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const renamed = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const result = renameComposeVolumes(document, new Map([['cache', renamed]]))
  const volumes = (result.data.services as Record<string, Record<string, unknown>>).web!
    .volumes as string[]
  assertEquals(volumes[0], ':/data')
  assertEquals(volumes[1], `${renamed}:/cache`)
})

test('renameComposeVolumes passes through non-record services', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: { bad: 'raw', web: { volumes: ['data:/data'] } },
      volumes: { data: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const renamed = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const result = renameComposeVolumes(document, new Map([['data', renamed]]))
  assertEquals((result.data.services as Record<string, unknown>).bad, 'raw')
})

test('renameComposeVolumes leaves non-volume long mounts unchanged', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          volumes: [
            { type: 'bind', source: '/host', target: '/data' },
            { type: 'volume', source: 'data', target: '/data' },
          ],
        },
      },
      volumes: { data: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const renamed = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const result = renameComposeVolumes(document, new Map([['data', renamed]]))
  const volumes = (result.data.services as Record<string, Record<string, unknown>>).web!
    .volumes as Array<Record<string, unknown> | string>
  assertEquals(volumes[0], { type: 'bind', source: '/host', target: '/data' })
  assertEquals(volumes[1], { type: 'volume', source: renamed, target: '/data' })
})

test('renameComposeVolumes rewrites inside !override service volumes and preserves tag', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      volumes: { data: {} },
      services: {
        web: {
          image: 'nginx',
          volumes: makeComposeTag('override', ['data:/data']),
        },
      },
    },
    presentation: { keyOrder: ['volumes', 'services'], comments: {} },
  }
  const renamed = '01936b3e-aaaa-bbbb-cccc-123456789abc'
  const result = renameComposeVolumes(document, new Map([['data', renamed]]))
  const web = (result.data.services as Record<string, Record<string, unknown>>).web!
  assertEquals(isComposeTaggedValue(web.volumes), true)
  assertEquals(composeTagOf(web.volumes), 'override')
  assertEquals(unwrapComposeTag(web.volumes), [`${renamed}:/data`])
})

test('renameComposeVolumes looks through tagged services mapping', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      volumes: { data: {} },
      services: makeComposeTag('override', {
        web: { volumes: ['data:/data'] },
      }),
    },
    presentation: { keyOrder: ['volumes', 'services'], comments: {} },
  }
  const renamed = 'vol-uuid'
  const result = renameComposeVolumes(document, new Map([['data', renamed]]))
  assertEquals(composeTagOf(result.data.services), 'override')
  const services = unwrapComposeTag(result.data.services) as Record<
    string,
    Record<string, unknown>
  >
  assertEquals(services.web.volumes, [`${renamed}:/data`])
})

test('renameComposeVolumes looks through tagged service body', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      volumes: { data: {} },
      services: {
        web: makeComposeTag('override', {
          image: 'nginx',
          volumes: ['data:/data'],
        }),
      },
    },
    presentation: { keyOrder: ['volumes', 'services'], comments: {} },
  }
  const renamed = 'vol-uuid'
  const result = renameComposeVolumes(document, new Map([['data', renamed]]))
  const web = (result.data.services as Record<string, unknown>).web
  assertEquals(composeTagOf(web), 'override')
  assertEquals(
    (unwrapComposeTag(web) as Record<string, unknown>).volumes,
    [`${renamed}:/data`],
  )
})
