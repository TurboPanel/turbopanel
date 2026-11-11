import { assertEquals } from '@std/assert'
import {
  type ApplyVariablesError,
  type ApplyVariablesResult,
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  isApplyVariablesError,
} from './apply-variables.ts'
import { emptyComposeDocument } from './types.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

function entry(
  key: string,
  value: string,
  overrides: Partial<DeployVariableEntry> = {}
): DeployVariableEntry {
  return {
    key,
    value,
    isSecret: false,
    isLiteral: false,
    forBuild: false,
    forRuntime: false,
    ...overrides,
  }
}

function compile(
  data: Record<string, unknown>,
  entries: DeployVariableEntry[],
  enabled = true
): ApplyVariablesResult | ApplyVariablesError {
  const doc = emptyComposeDocument()
  doc.data = data
  return applyVariablesToComposeDocument(doc, {
    globalEntries: entries,
    perServiceEntries: new Map(),
    projectId: 'p1',
    environmentId: 'e1',
    configFilesEnabled: enabled,
  })
}

function ok(result: ApplyVariablesResult | ApplyVariablesError) {
  if (isApplyVariablesError(result)) throw new TypeError(result.message)
  return result
}

function failure(result: ApplyVariablesResult | ApplyVariablesError) {
  if (!isApplyVariablesError(result)) throw new TypeError('expected an error')
  return result
}

const PGADMIN = {
  services: {
    pgadmin: {
      image: 'pgadmin',
      configs: [
        { source: 'servers', target: '/pgadmin4/servers.json' },
        { source: 'pgpass', target: '/pgadmin4/pgpass', mode: '0600' },
      ],
    },
  },
  configs: {
    servers: { content: '{"Host": "{$DB_HOST}", "Port": {$DB_PORT}}\n' },
    pgpass: { content: '{$DB_HOST}:{$DB_PORT}:*:app:{$DB_PASSWORD}\n' },
  },
}

const DB = [
  entry('DB_HOST', 'db.internal'),
  entry('DB_PORT', '5432'),
  entry('DB_PASSWORD', 'tpsecret.v1.sealed', { isSecret: true }),
]

test('a text file gets only text parts and a file-backed config', () => {
  const result = ok(compile(PGADMIN, DB))
  const servers = result.configFiles.find((f) => f.source === 'pgadmin_servers')
  assertEquals(servers?.parts, [
    {
      text: '{"Host": "db.internal", "Port": 5432}\n',
    },
  ])
  assertEquals(servers?.relativePath, 'pgadmin--servers')
  const configs = result.document.data.configs as Record<string, unknown>
  assertEquals(configs.pgadmin_servers, {
    file: '/run/turbopanel/deployments/p1/e1/configs/pgadmin--servers',
  })
  assertEquals('servers' in configs, false)
  const service = (result.document.data.services as Record<string, any>).pgadmin
  assertEquals(service.configs[0], {
    source: 'pgadmin_servers',
    target: '/pgadmin4/servers.json',
  })
})

test('a secret becomes a key part with sealed material and no secret plan or mount', () => {
  const result = ok(compile(PGADMIN, DB))
  const pgpass = result.configFiles.find((f) => f.source === 'pgadmin_pgpass')
  assertEquals(pgpass?.parts, [
    { text: 'db.internal:5432:*:app:' },
    { secretKey: 'DB_PASSWORD' },
    { text: '\n' },
  ])
  assertEquals(result.secretPlan, [])
  assertEquals(result.secretMaterial.length, 1)
  assertEquals(result.secretMaterial[0]?.key, 'DB_PASSWORD')
  assertEquals(result.secretMaterial[0]?.forRuntime, false)
  assertEquals(result.configSecretRefs, [
    {
      composeServiceName: 'pgadmin',
      key: 'DB_PASSWORD',
    },
  ])
  assertEquals('secrets' in result.document.data, false)
  assertEquals(result.envFileContent.includes('tpsecret'), false)
  assertEquals(JSON.stringify(result.document.data).includes('tpsecret'), false)
})

test('a secret both mounted and read by a config has one material entry', () => {
  const data = {
    services: {
      web: {
        image: 'x',
        environment: { DB_PASSWORD: '{$DB_PASSWORD}' },
        configs: ['pgpass'],
      },
    },
    configs: { pgpass: { content: 'pw={$DB_PASSWORD}' } },
  }
  const result = ok(compile(data, DB))
  assertEquals(result.secretMaterial.length, 1)
  assertEquals(result.secretPlan.length, 1)
  assertEquals(result.secretMaterial[0]?.forRuntime, true)
})

test('the PHP case: $$ becomes $ in text and {$DB_HOST} the real host', () => {
  const data = {
    services: { php: { image: 'x', configs: ['conf'] } },
    configs: {
      conf: { content: "$$cfg['Servers'][$$i]['host'] = '{$DB_HOST}';" },
    },
  }
  const result = ok(compile(data, DB))
  assertEquals(result.configFiles[0]?.parts, [
    {
      text: "$cfg['Servers'][$i]['host'] = 'db.internal';",
    },
  ])
  assertEquals(result.configFiles[0]?.parts.length, 1)
})

test('a literal {$name} is written {$$name}', () => {
  const data = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: '{$$name} costs $$5' } },
  }
  assertEquals(ok(compile(data, [])).configFiles[0]?.parts, [
    {
      text: '{$name} costs $5',
    },
  ])
})

test('values are inserted once and never scanned or reduced again', () => {
  const data = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: 'v={$V}' } },
  }
  const result = ok(compile(data, [entry('V', '{$DB_HOST} $$ ${HOME}')]))
  assertEquals(result.configFiles[0]?.parts, [
    {
      text: 'v={$DB_HOST} $$ ${HOME}',
    },
  ])
})

test('Compose interpolation in config content is refused', () => {
  for (const content of ['a ${HOME}', 'a $HOME']) {
    const data = {
      services: { a: { image: 'x', configs: ['c'] } },
      configs: { c: { content } },
    }
    assertEquals(failure(compile(data, [])).kind, 'config_interpolation')
  }
})

test('an unresolved or invalid reference is refused', () => {
  const data = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: '{$MISSING}' } },
  }
  assertEquals(failure(compile(data, [])).kind, 'variable_unresolved')
  data.configs.c.content = '{$nowhere.KEY}'
  assertEquals(failure(compile(data, [])).kind, 'variable_ref_invalid')
})

test('owner and mode are dropped with a warning', () => {
  const result = ok(compile(PGADMIN, DB))
  const service = (result.document.data.services as Record<string, any>).pgadmin
  assertEquals(service.configs[1], {
    source: 'pgadmin_pgpass',
    target: '/pgadmin4/pgpass',
  })
  assertEquals(result.configWarnings.length, 1)
  assertEquals(result.configWarnings[0]?.source, 'pgpass')
})

test('two services each get their own file from one top-level config', () => {
  const data = {
    services: {
      a: { image: 'x', configs: ['c'] },
      b: { image: 'x', configs: ['c'] },
    },
    configs: { c: { content: '{$DB_HOST}' } },
  }
  const result = ok(compile(data, DB))
  assertEquals(
    result.configFiles.map((f) => f.source),
    ['a_c', 'b_c']
  )
  assertEquals(
    result.configFiles.map((f) => f.composeServiceName),
    ['a', 'b']
  )
})

test("a service naming another service's generated source is refused", () => {
  const data = {
    services: {
      a: { image: 'x', configs: ['c'] },
      b: { image: 'x', configs: ['a_c'] },
    },
    configs: { c: { content: 'x' }, a_c: { file: '/etc/shadow' } },
  }
  const error = failure(compile(data, []))
  assertEquals(error.kind, 'config_file_invalid')
})

test('another service cannot bind a generated source of a different service', () => {
  const data = {
    services: {
      a: { image: 'x', configs: ['c'] },
      b: { image: 'x', configs: [{ source: 'a_c' }] },
    },
    configs: { c: { content: 'x' } },
  }
  assertEquals(failure(compile(data, [])).kind, 'config_file_shared')
})

test('colliding generated names are refused', () => {
  const data = {
    services: {
      a_b: { image: 'x', configs: ['c'] },
      a: { image: 'x', configs: ['b_c'] },
    },
    configs: { c: { content: 'x' }, b_c: { content: 'y' } },
  }
  assertEquals(failure(compile(data, [])).kind, 'config_file_invalid')
})

test('a config name ending in .tmp is refused', () => {
  const data = {
    services: { a: { image: 'x', configs: ['c.tmp'] } },
    configs: { 'c.tmp': { content: 'x' } },
  }
  assertEquals(failure(compile(data, [])).kind, 'config_file_invalid')
})

test('an unused content config is removed', () => {
  const data = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: 'x' }, unused: { content: '{$DB_HOST}' } },
  }
  const configs = ok(compile(data, DB)).document.data.configs as Record<string, unknown>
  assertEquals(Object.keys(configs), ['a_c'])
})

test('without the daemon feature a real reference is refused, text without one is left as authored', () => {
  assertEquals(failure(compile(PGADMIN, DB, false)).kind, 'config_files_need_daemon_update')
  const secretOnly = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: '{$DB_PASSWORD}' } },
  }
  assertEquals(failure(compile(secretOnly, DB, false)).kind, 'config_files_need_daemon_update')
  const plain = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: 'stray {$ and $$x text' } },
  }
  const result = ok(compile(plain, DB, false))
  assertEquals(result.configFiles, [])
  assertEquals((result.document.data.configs as Record<string, unknown>).c, {
    content: 'stray {$ and $$x text',
  })
})

test('size limits are enforced', () => {
  const big = 'x'.repeat(65_537)
  const data = {
    services: { a: { image: 'x', configs: ['c'] } },
    configs: { c: { content: big } },
  }
  assertEquals(failure(compile(data, [])).kind, 'config_file_invalid')
  const many = {
    services: {
      a: {
        image: 'x',
        configs: Array.from({ length: 17 }, (_, i) => `c${i}`),
      },
    },
    configs: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, { content: 'x' }])),
  }
  assertEquals(failure(compile(many, [])).kind, 'config_file_invalid')
  const total = {
    services: Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`s${i}`, { image: 'x', configs: ['c'] }])
    ),
    configs: { c: { content: 'x'.repeat(60_000) } },
  }
  assertEquals(failure(compile(total, [])).kind, 'config_file_invalid')
})
