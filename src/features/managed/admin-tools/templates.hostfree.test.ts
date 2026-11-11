import { assert, assertEquals, assertThrows } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  isApplyVariablesError,
} from '../../compose/index.ts'
import { generatePassword } from '../../../lib/secrets/generate-secret.ts'
import {
  ADMIN_TOOLS,
  adminToolCompose,
  adminToolFitsEngine,
  type AdminToolId,
  isAcceptablePgAdminEmail,
} from './templates.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const CASES: ReadonlyArray<{ tool: AdminToolId; engine: string }> = [
  { tool: 'phpmyadmin', engine: 'mysql' },
  { tool: 'phpmyadmin', engine: 'mariadb' },
  { tool: 'adminer', engine: 'mysql' },
  { tool: 'adminer', engine: 'mariadb' },
  { tool: 'adminer', engine: 'postgres' },
  { tool: 'pgadmin', engine: 'postgres' },
]

function binding(key: string, value: string, isSecret = false): DeployVariableEntry {
  return {
    key,
    value,
    isSecret,
    isLiteral: false,
    forBuild: false,
    forRuntime: false,
    bindingId: 'b1',
  }
}

const ENTRIES: DeployVariableEntry[] = [
  binding('DB_HOST', 'db.internal'),
  binding('DB_PORT', '5432'),
  binding('DB_NAME', 'main'),
  binding('DB_USER', 'tool_k3x9q2'),
  binding('DB_PASSWORD', 'tpsecret.v1.sealed', true),
  binding('DB_CA_CERT', 'tpsecret.v1.sealedca', true),
  {
    key: 'TOOL_WEB_PASSWORD',
    value: 'tpsecret.v1.sealedweb',
    isSecret: true,
    isLiteral: false,
    forBuild: false,
    forRuntime: false,
  },
]

function compile(tool: AdminToolId, engine: string) {
  const document = adminToolCompose({
    tool,
    engine,
    hostname: 'db-admin.example.com',
    email: 'me@example.org',
    revision: 3,
  })
  const result = applyVariablesToComposeDocument(document, {
    globalEntries: [],
    perServiceEntries: new Map([['tool', ENTRIES]]),
    projectId: 'p1',
    environmentId: 'e1',
    configFilesEnabled: true,
  })
  if (isApplyVariablesError(result)) throw new TypeError(result.message)
  return { document, result }
}

function toolService(data: Record<string, unknown>): Record<string, unknown> {
  const services = data.services as Record<string, Record<string, unknown>>
  return services.tool
}

test('every tool compiles with no interpolation error', () => {
  for (const { tool, engine } of CASES) {
    const { result } = compile(tool, engine)
    assert(result.document.data.services, `${tool} on ${engine}`)
  }
})

test('images are the pinned constants and the hosting names the tool port', () => {
  for (const { tool, engine } of CASES) {
    const { document } = compile(tool, engine)
    const service = toolService(document.data)
    assertEquals(service.image, ADMIN_TOOLS[tool].image)
    assertEquals((service['x-turbopanel'] as { hosting: unknown[] }).hosting, [
      { hostname: 'db-admin.example.com', targetPort: ADMIN_TOOLS[tool].port },
    ])
    assertEquals(service.volumes, undefined)
    assertEquals(service.ports, undefined)
  }
})

test('the pinned tags are the owner-approved ones', () => {
  assertEquals(ADMIN_TOOLS.phpmyadmin.image, 'phpmyadmin:5.2.3')
  assertEquals(ADMIN_TOOLS.adminer.image, 'adminer:6.3.0')
  assertEquals(ADMIN_TOOLS.pgadmin.image, 'dpage/pgadmin4:9.19')
})

test('phpMyAdmin never presets a sign-in and keeps its server fixed', () => {
  const { document } = compile('phpmyadmin', 'mariadb')
  const env = toolService(document.data).environment as Record<string, string>
  for (const key of ['PMA_USER', 'PMA_PASSWORD', 'PMA_ARBITRARY']) {
    assertEquals(env[key], undefined)
  }
  assertEquals(env.PMA_SSL_CA, '/run/secrets/DB_CA_CERT')
  assertEquals(env.PMA_SSL_VERIFY, '1')
})

test('phpMyAdmin gets the CA file mounted through the binding secret', () => {
  const { result } = compile('phpmyadmin', 'mysql')
  const keys = result.secretPlan.map((entry) => entry.key)
  assert(keys.includes('DB_CA_CERT'), JSON.stringify(keys))
})

test('pgAdmin gets only the file form of its web password', () => {
  const { result } = compile('pgadmin', 'postgres')
  const env = JSON.stringify(toolService(result.document.data).environment)
  assert(env.includes('PGADMIN_DEFAULT_PASSWORD_FILE'), env)
  assert(!env.includes('"PGADMIN_DEFAULT_PASSWORD"'), env)
})

test('pgAdmin settings: port, re-import, no volume, one pass file', () => {
  const { document } = compile('pgadmin', 'postgres')
  const service = toolService(document.data)
  const env = service.environment as Record<string, string>
  assertEquals(env.PGADMIN_LISTEN_PORT, '8080')
  assertEquals(env.PGADMIN_REPLACE_SERVERS_ON_STARTUP, 'True')
  assertEquals(env.PGPASS_FILE, '/pgadmin4/pgpass')
  assertEquals(env.ADMIN_TOOL_REVISION, '3')
  assertEquals(service.volumes, undefined)
})

test('the pass file holds the database password as the only secret part', () => {
  const { result } = compile('pgadmin', 'postgres')
  const pgpass = result.configFiles.find((file) => file.source.endsWith('pgadmin_pgpass'))
  assert(pgpass, 'pass file missing')
  const secrets = pgpass.parts.filter((part) => 'secretKey' in part)
  assertEquals(secrets, [{ secretKey: 'DB_PASSWORD' }])
})

test('Adminer plugin files carry no secret part', () => {
  const { result } = compile('adminer', 'postgres')
  const files = result.configFiles.filter((file) => file.source.includes('adminer'))
  assertEquals(files.length, 2)
  for (const file of files) {
    assertEquals(
      file.parts.filter((part) => 'secretKey' in part),
      []
    )
  }
})

test('Adminer on Postgres uses libpq full verification and the CA path', () => {
  const { document } = compile('adminer', 'postgres')
  const env = toolService(document.data).environment as Record<string, string>
  assertEquals(env.PGSSLROOTCERT, '/run/secrets/DB_CA_CERT')
  const ssl = (document.data.configs as Record<string, { content: string }>).adminer_ssl.content
  assert(ssl.includes("'mode' => 'verify-full'"))
})

test('a tool on the wrong engine is refused', () => {
  assertEquals(adminToolFitsEngine('pgadmin', 'mysql'), false)
  assertEquals(adminToolFitsEngine('phpmyadmin', 'postgres'), false)
  assertThrows(
    () =>
      adminToolCompose({
        tool: 'pgadmin',
        engine: 'mysql',
        hostname: 'a.example.com',
        revision: 1,
      }),
    TypeError
  )
})

test('a dollar sign in the sign-in email is escaped', () => {
  const document = adminToolCompose({
    tool: 'pgadmin',
    engine: 'postgres',
    hostname: 'a.example.com',
    email: 'a$b@example.org',
    revision: 1,
  })
  const env = toolService(document.data).environment as Record<string, string>
  assertEquals(env.PGADMIN_DEFAULT_EMAIL, 'a$$b@example.org')
})

test('special-use email domains are refused', () => {
  assertEquals(isAcceptablePgAdminEmail('me@example.org'), true)
  assertEquals(isAcceptablePgAdminEmail('me@foo.test'), false)
  assertEquals(isAcceptablePgAdminEmail('me@host.local'), false)
  assertEquals(isAcceptablePgAdminEmail('me@localhost'), false)
  assertEquals(isAcceptablePgAdminEmail('nope'), false)
})

test('generated passwords stay inside the alphabet the templates rely on', () => {
  assert(/^[A-Za-z0-9_]+$/u.test(generatePassword(48)))
})
