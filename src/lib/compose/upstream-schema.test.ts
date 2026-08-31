import { assertEquals } from '@std/assert'
import { resolveReplicaPolicy } from '../schedule/interpret.ts'
import {
  ANNOTATION_SCHEMA_KEYWORDS,
  COMPOSE_SPEC_SCHEMA_REVISION,
  IMPLEMENTED_SCHEMA_KEYWORDS,
} from './upstream-schema.ts'
import COMPOSE_SPEC_SCHEMA_JSON from './vendor/compose-spec.schema.json' with {
  type: 'json',
}
import { lintComposeYaml } from './lint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('the vendored schema is pinned, not tracking upstream main', () => {
  // A moving schema is a validator whose verdict on an unchanged document
  // changes without a commit. If this fails, `vendor/README.md` was updated
  // without the module constant (or the other way round).
  assertEquals(/^[0-9a-f]{40}$/.test(COMPOSE_SPEC_SCHEMA_REVISION), true)
})

test('a wrong type is a blocking structural error', () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    healthcheck:
      test: ["CMD", "true"]
      interval: 30
`)
  const found = issues.find((issue) =>
    issue.path === 'services.web.healthcheck.interval'
  )
  assertEquals(found?.level, 'error')
  assertEquals(found?.message.includes('Compose Specification'), true)
})

test('an unknown key inside deploy comes from the schema, once', () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    deploy:
      replicaz: 2
`)
  const found = issues.filter((issue) =>
    issue.path === 'services.web.deploy.replicaz'
  )
  assertEquals(found.length, 1)
  assertEquals(found[0]?.level, 'error')
})

test('the semantic linter keeps the last word on root and service keys', () => {
  // Both stages can see these; only the one that can suggest a spelling speaks.
  const issues = lintComposeYaml(`services:
  web:
    imaage: nginx:alpine
    image: nginx:alpine
`)
  const found = issues.filter((issue) => issue.path === 'services.web.imaage')
  assertEquals(found.length, 1)
  assertEquals(found[0]?.message.includes('did you mean "image"'), true)
})

test('interpolation is never a schema violation', () => {
  // `{$PORT}` and `${PORT}` stand for values the schema cannot see; treating
  // them as type errors would refuse ordinary TurboPanel documents.
  assertEquals(
    lintComposeYaml(`services:
  web:
    image: nginx:alpine
    container_name: "{$APP_NAME}"
    deploy:
      replicas: "\${WEB_REPLICAS}"
`),
    [],
  )
})

test('a half-typed value is a draft, not a violation', () => {
  assertEquals(
    lintComposeYaml(`services:
  web:
    image: nginx:alpine
    environment:
    deploy:
`),
    [],
  )
})

test('overlay tags are left to the merge that resolves them', () => {
  assertEquals(
    lintComposeYaml(
      `services:
  web:
    image: nginx:alpine
    environment: !override
      RETRIES: 3
`,
      { layer: 'overlay' },
    ),
    [],
  )
})

test('a required key inside a closed object is reported', () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    develop:
      watch:
        - path: ./src
`)
  const found = issues.find((issue) =>
    issue.path.startsWith('services.web.develop.watch')
  )
  assertEquals(found?.level, 'error')
  assertEquals(found?.message.includes('action'), true)
})

test('every keyword the vendored schema uses is one this module evaluates', () => {
  // The guard behind "the pinned schema is enforced, not approximated". A
  // vendored refresh that introduces `allOf`, `if`/`then`, `prefixItems`,
  // `minLength`, … fails here instead of quietly validating less than the
  // schema says. Add the keyword to the evaluator, then to the set.
  const seen = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      seen.add(key)
      // Below `properties` / `patternProperties` / `$defs` the keys are
      // *names*, not keywords; only their values are schemas.
      if (
        key === 'properties' || key === 'patternProperties' || key === '$defs'
      ) {
        for (const sub of Object.values(value as Record<string, unknown>)) {
          walk(sub)
        }
        continue
      }
      walk(value)
    }
  }
  walk(COMPOSE_SPEC_SCHEMA_JSON)

  const unhandled = [...seen]
    .filter((keyword) =>
      !IMPLEMENTED_SCHEMA_KEYWORDS.has(keyword) &&
      !ANNOTATION_SCHEMA_KEYWORDS.has(keyword)
    )
    .sort()
  assertEquals(unhandled, [])
})

test('a numeric bound is enforced, not skipped', () => {
  // `oom_score_adj` is `oneOf[string, integer -1000..1000]`. Discriminating the
  // union by type alone accepted every integer, bounds and all.
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    oom_score_adj: 2000
`)
  const found = issues.find((issue) =>
    issue.path === 'services.web.oom_score_adj'
  )
  assertEquals(found?.level, 'error')
  assertEquals(found?.message.includes('<= 1000'), true)
})

test('a pattern is enforced on a real value and stands down for a placeholder', () => {
  const bad = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    pull_policy: sometimes
`)
  assertEquals(
    bad.find((issue) => issue.path === 'services.web.pull_policy')?.level,
    'error',
  )
  assertEquals(
    lintComposeYaml(`services:
  web:
    image: nginx:alpine
    pull_policy: "{$PULL_POLICY}"
`),
    [],
  )
})

test('uniqueItems is enforced', () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    cap_add:
      - NET_ADMIN
      - NET_ADMIN
`)
  assertEquals(
    issues.find((issue) => issue.path === 'services.web.cap_add[1]')?.level,
    'error',
  )
})

test('oneOf descends into its branches instead of stopping at the type', () => {
  // The long-form `volumes:` entry requires `type:`. Type discrimination alone
  // saw "an object, which one branch allows" and never looked inside.
  const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    volumes:
      - source: data
        target: /data
`)
  const found = issues.find((issue) =>
    issue.path === 'services.web.volumes[0]'
  )
  assertEquals(found?.level, 'error')
  assertEquals(found?.message.includes('required key "type"'), true)
})

/**
 * `deploy.replicas` is the field where "validated less than the schema says"
 * turns into a different deployment than the author asked for.
 *
 * `resolveReplicaPolicy` (`lib/schedule/interpret.ts`) accepts only a whole
 * number of at least one; anything else is discarded and the count falls back
 * to `service.options.instances` or to `1`. So for every value below, the
 * question is not whether the deploy would fail — it is whether the deploy
 * would quietly run a *different* number of replicas. The assertion pairs each
 * case with the count that fallback would have produced, so the test fails if
 * the validation ever stops catching it first.
 */
for (
  const testCase of [
    { label: 'a float', authored: '1.5', value: 1.5 },
    { label: 'a boolean', authored: 'true', value: true },
    { label: 'a sequence', authored: '[2]', value: [2] },
    { label: 'a mapping', authored: '{ count: 2 }', value: { count: 2 } },
    { label: 'zero', authored: '0', value: 0 },
    { label: 'a negative count', authored: '-3', value: -3 },
    { label: 'a non-numeric string', authored: '"two"', value: 'two' },
  ]
) {
  test(`deploy.replicas as ${testCase.label} is refused before interpret can fall back`, () => {
    const issues = lintComposeYaml(`services:
  web:
    image: nginx:alpine
    deploy:
      replicas: ${testCase.authored}
`)
    assertEquals(
      issues.find((issue) => issue.path === 'services.web.deploy.replicas')
        ?.level,
      'error',
      `expected an error for replicas: ${testCase.authored}`,
    )
    // What would have happened without it: the authored value discarded and a
    // different count deployed, with nothing said about the substitution.
    assertEquals(
      resolveReplicaPolicy({ deploy: { replicas: testCase.value } }, 4).replicas,
      4,
    )
  })
}

test('a replica count TurboPanel can honour passes both stages', () => {
  assertEquals(
    lintComposeYaml(`services:
  web:
    image: nginx:alpine
    deploy:
      replicas: 3
`),
    [],
  )
  assertEquals(
    resolveReplicaPolicy({ deploy: { replicas: 3 } }, 4).replicas,
    3,
  )
})
