import { assertEquals } from 'jsr:@std/assert'
import { parse as parseYaml } from 'jsr:@std/yaml'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { ManagedSecretPlaceholder } from '../../lib/managed/index.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import { DEFAULT_MANAGED_SETTINGS } from '../../lib/managed/settings.ts'
import { parseManagedApplyPayload } from '../../lib/commands/schemas.ts'
import { composeDocumentToYaml } from '../../lib/compose/convert.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import {
  buildManagedApplyPayload,
  isPrepareError,
  preflightManagedApplyInfrastructure,
} from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function fakeContext(): Context<AppEnv> {
  const app = new Hono<AppEnv>()
  let captured: Context<AppEnv> | undefined
  app.get('/', (c) => {
    captured = c
    return c.json({})
  })
  // Trigger handler synchronously via mock is awkward; build a minimal stub.
  return {
    get: () => undefined,
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>
}

test('buildManagedApplyPayload returns daemon_key_unavailable without encryption context', async () => {
  const c = fakeContext()
  const managedId = '00000000-0000-4000-8000-000000000099'
  const payload = await buildManagedApplyPayload(c, {} as never, {
    managedRow: { id: managedId },
    spec: postgresEngineSpec,
    settings: {
      ...DEFAULT_MANAGED_SETTINGS,
      ssl: { enabled: false },
      exposure: { enabled: false },
    },
    databases: ['postgres'],
    serverId: '00000000-0000-4000-8000-000000000001',
    environmentId: '00000000-0000-4000-8000-000000000002',
  })

  assertEquals(isPrepareError(payload), true)
  if (!isPrepareError(payload)) {
    throw new TypeError('expected prepare error without encryption context')
  }
  assertEquals(payload.kind, 'daemon_key_unavailable')
})

test('preflightManagedApplyInfrastructure returns daemon_key_unavailable without encryption context', async () => {
  const c = fakeContext()
  const error = await preflightManagedApplyInfrastructure(c, {} as never, {
    serverId: '00000000-0000-4000-8000-000000000001',
    bind: 'local',
  })
  assertEquals(error?.kind, 'daemon_key_unavailable')
})

test('runtime compose YAML has one service, no ports, placeholder, hyphen-free volume', () => {
  const managedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const settings = {
    ...DEFAULT_MANAGED_SETTINGS,
    ssl: { enabled: false },
    exposure: { enabled: false },
  }
  const runtime = postgresEngineSpec.buildRuntimeSpec({
    managedId,
    settings,
    rootUsername: postgresEngineSpec.rootUsername,
  })

  assertEquals(runtime.env.POSTGRES_PASSWORD, ManagedSecretPlaceholder)
  assertEquals('ports' in runtime.service, false)
  assertEquals(runtime.volumes[0]?.name.includes('-'), false)

  const volumes: Record<string, Record<string, never>> = {}
  for (const volume of runtime.volumes) {
    volumes[volume.name] = {}
  }
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: { [runtime.composeServiceName]: runtime.service },
      volumes,
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const yaml = composeDocumentToYaml(document)
  const parsed = parseYaml(yaml) as Record<string, unknown>
  const services = parsed.services as Record<string, unknown>
  assertEquals(Object.keys(services).length, 1)
  assertEquals('ports' in (services.postgres as object), false)

  const accepted = parseManagedApplyPayload({
    managedId,
    environmentId: '00000000-0000-4000-8000-000000000002',
    engine: 'postgres',
    projectName: `turbopanel-managed-${managedId}`,
    image: postgresEngineSpec.defaultImage,
    containerPort: 5432,
    composeYaml: yaml,
    configFiles: runtime.configFiles,
    volumes: runtime.volumes,
    exposure: { enabled: false, protocol: 'tcp' },
    credentials: [
      {
        principalId: '00000000-0000-4000-8000-000000000003',
        username: 'postgres',
        role: 'root',
        databases: ['postgres'],
        password: 'tpdaemon.v1.server.key.1.iv.ciphertext',
      },
    ],
  })
  assertEquals(accepted.managedId, managedId)
  assertEquals(accepted.volumes[0]?.name.includes('-'), false)
})
