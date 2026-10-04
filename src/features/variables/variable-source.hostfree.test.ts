import { assertEquals } from '@std/assert'
import {
  resolveVariableSource,
  type ResolvedVariableEntry,
  type ResolvedVariableScopes,
} from './resolve-inherited.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const entry: ResolvedVariableEntry = {
  value: 'v',
  isSecret: false,
  isLiteral: false,
  forBuild: false,
  forRuntime: true,
}

function scopes(keysByScope: Record<string, string[]>): ResolvedVariableScopes {
  return Object.fromEntries(
    Object.entries(keysByScope).map(([scope, keys]) => [
      scope,
      new Map(keys.map((key) => [key, entry])),
    ])
  )
}

test('the closest scope wins, in the order deploy applies them', () => {
  const all = scopes({
    organization: ['A'],
    workspace: ['A'],
    project: ['A'],
    environment: ['A'],
  })
  assertEquals(resolveVariableSource('A', null, all), 'environment')
  assertEquals(
    resolveVariableSource('A', null, { ...all, service: new Map([['A', entry]]) }),
    'service'
  )
  assertEquals(
    resolveVariableSource('A', null, scopes({ organization: ['A'], project: ['A'] })),
    'project'
  )
  assertEquals(resolveVariableSource('A', null, scopes({ organization: ['A'] })), 'organization')
})

test('hosting beats the service chain, and the server beats everything', () => {
  const chain = scopes({ service: ['A'], hosting: ['A'] })
  assertEquals(resolveVariableSource('A', null, chain), 'hosting')
  assertEquals(
    resolveVariableSource('A', null, { ...chain, server: new Map([['A', entry]]) }),
    'server'
  )
})

test('a binding-owned value is labelled binding unless the server overrides it', () => {
  const chain = scopes({ service: ['DATABASE_URL'], hosting: ['DATABASE_URL'] })
  assertEquals(resolveVariableSource('DATABASE_URL', 'binding-1', chain), 'binding')
  assertEquals(
    resolveVariableSource('DATABASE_URL', 'binding-1', {
      ...chain,
      server: new Map([['DATABASE_URL', entry]]),
    }),
    'server'
  )
})

test('no scope map, no guess', () => {
  assertEquals(resolveVariableSource('A', null, {}), undefined)
  assertEquals(resolveVariableSource('A', undefined, scopes({ project: ['B'] })), undefined)
})
