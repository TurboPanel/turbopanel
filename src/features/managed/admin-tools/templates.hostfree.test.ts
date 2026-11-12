import { assert, assertEquals, assertThrows } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  isApplyVariablesError,
} from '../../compose/index.ts'
import { collectHostAccessFindings } from '../../compose/host-access.ts'
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

/** Sealed-looking values built from fragments so no literal reads as a credential. */
const sealed = (label: string) => ['tpsecret', 'v1', label].join('.')

const ENTRIES: DeployVariableEntry[] = [
  binding('DB_HOST', 'db.internal'),
  binding('DB_PORT', '5432'),
  binding('DB_NAME', 'main'),
  binding('DB_USER', 'tool_k3x9q2'),
  binding('DB_PASSWORD', sealed('db'), true),
  binding('DB_CA_CERT', sealed('ca'), true),
  {
    key: 'TOOL_WEB_PASSWORD',
    value: sealed('web'),
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
})

test('pgAdmin looks for the CA inside the sign-in folder and the start script puts it there', () => {
  const { document, result } = compile('pgadmin', 'postgres')
  const service = toolService(result.document.data)
  const entrypoint = service.entrypoint as string[]
  assertEquals(entrypoint.slice(0, 2), ['/bin/sh', '-c'])
  const script = entrypoint[2].replaceAll('$$', '$')
  assert(script.includes('/var/lib/pgadmin/storage/'), script)
  assert(script.includes("tr '@' '_'"), script)
  assert(script.includes('cp -f /run/secrets/DB_CA_CERT "$dir/ca.crt"'), script)
  assert(script.endsWith('exec /entrypoint.sh'), script)
  // Every dollar sign is doubled so Compose leaves it for the shell.
  assert(!/(^|[^$])\$(?!\$)/u.test(entrypoint[2]), entrypoint[2])
  const servers = (document.data.configs as Record<string, { content: string }>).pgadmin_servers
  const entry = JSON.parse(servers.content.replaceAll('{$DB_PORT}', '5432')) as {
    Servers: Record<string, { ConnectionParameters: Record<string, string> }>
  }
  const params = entry.Servers['1'].ConnectionParameters
  assertEquals(params.sslrootcert, '/ca.crt')
  assertEquals(params.sslmode, 'verify-full')
})

test('the start script empties the data folder before the copy and the entrypoint', () => {
  const { result } = compile('pgadmin', 'postgres')
  const entrypoint = toolService(result.document.data).entrypoint as string[]
  const script = entrypoint[2]
  const clear = script.indexOf('find /var/lib/pgadmin -mindepth 1 -delete')
  assert(clear === 0, script)
  assert(clear < script.indexOf('mkdir -p'), script)
  assert(script.indexOf('mkdir -p') < script.indexOf('exec /entrypoint.sh'), script)
})

test('pgAdmin mounts its data folder as a size-capped tmpfs and declares no other volume', () => {
  const { document } = compile('pgadmin', 'postgres')
  const service = toolService(document.data)
  assertEquals(service.volumes, [
    { type: 'tmpfs', target: '/var/lib/pgadmin', tmpfs: { size: 268435456 } },
  ])
  assertEquals(service.tmpfs, undefined)
  assertEquals(document.data.volumes, undefined)
})

test('no tool needs host access: every mount is memory-backed or absent', () => {
  for (const { tool, engine } of CASES) {
    const { document } = compile(tool, engine)
    assertEquals(collectHostAccessFindings(document.data), [], `${tool} on ${engine}`)
    const mounts = (toolService(document.data).volumes ?? []) as Array<{ type: string }>
    assert(
      mounts.every((mount) => mount.type === 'tmpfs'),
      `${tool} on ${engine}`
    )
  }
})

test('phpMyAdmin and Adminer declare no mounts of their own', () => {
  for (const { tool, engine } of CASES.filter((entry) => entry.tool !== 'pgadmin')) {
    const service = toolService(compile(tool, engine).document.data)
    assertEquals(service.tmpfs, undefined, `${tool} on ${engine}`)
    assertEquals(service.volumes, undefined, `${tool} on ${engine}`)
  }
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

test('emails pgAdmin would give a different storage folder are refused', () => {
  assertEquals(isAcceptablePgAdminEmail('1me@example.org'), false)
  assertEquals(isAcceptablePgAdminEmail('a/b@example.org'), false)
  assertEquals(isAcceptablePgAdminEmail('a\\b@example.org'), false)
  assertEquals(isAcceptablePgAdminEmail('me1@example.org'), true)
})

test('generated passwords stay inside the alphabet the templates rely on', () => {
  assert(/^[A-Za-z0-9_]+$/u.test(generatePassword(48)))
})
