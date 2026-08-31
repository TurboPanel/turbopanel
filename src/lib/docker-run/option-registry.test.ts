import { assertEquals } from '@std/assert'
import {
  DOCKER_RUN_OPTION_NAMES,
  DOCKER_RUN_OPTIONS,
  dockerRunOptionName,
  lookupDockerRunOption,
} from './option-registry.ts'
import fixture from './option-registry.fixture.json' with { type: 'json' }

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * The drift guard, and the reason this fixture is committed.
 *
 * A `docker run` parser that meets an unclassified flag does not fail — it
 * quietly treats the next token as the IMAGE. So "Docker shipped a new option"
 * has to be a CI failure, not a runtime surprise: adding or reclassifying an
 * option means editing the table **and** the fixture in the same commit, and a
 * reviewer sees both halves in the diff.
 *
 * Regenerate with:
 *   deno eval "import { DOCKER_RUN_OPTIONS } from './src/lib/docker-run/option-registry.ts'; \
 *     console.log(JSON.stringify({ options: DOCKER_RUN_OPTIONS.map((d) => ({ names: [...d.names], behavior: d.behavior })) }, null, 2))" \
 *     > src/lib/docker-run/option-registry.fixture.json
 */
test('the option table matches its committed fixture exactly', () => {
  const live = DOCKER_RUN_OPTIONS.map((definition) => ({
    names: [...definition.names],
    behavior: definition.behavior,
  }))
  assertEquals(live, fixture.options)
})

test('every unsupported or ignored option carries a quotable reason', () => {
  for (const definition of DOCKER_RUN_OPTIONS) {
    if (
      definition.behavior !== 'unsupported' &&
      definition.behavior !== 'operational'
    ) {
      continue
    }
    // A bare "not imported" tells an operator nothing they can act on.
    assertEquals(
      typeof definition.reason,
      'string',
      `${dockerRunOptionName(definition)} has no reason`,
    )
    assertEquals(
      (definition.reason ?? '').length > 20,
      true,
      `${dockerRunOptionName(definition)} has a stub reason`,
    )
  }
})

test('every spelling resolves back to its own definition', () => {
  for (const definition of DOCKER_RUN_OPTIONS) {
    for (const name of definition.names) {
      assertEquals(lookupDockerRunOption(name), definition)
    }
  }
})

test('no two options claim the same spelling', () => {
  const spellings = DOCKER_RUN_OPTIONS.flatMap((definition) => definition.names)
  assertEquals(spellings.length, new Set(spellings).size)
  assertEquals(DOCKER_RUN_OPTION_NAMES.size, spellings.length)
})

test('shorthands come first and the canonical long name comes last', () => {
  for (const definition of DOCKER_RUN_OPTIONS) {
    const canonical = dockerRunOptionName(definition)
    assertEquals(canonical.startsWith('--'), true, canonical)
    for (const name of definition.names.slice(0, -1)) {
      assertEquals(/^-[A-Za-z]$/.test(name), true, name)
    }
  }
})

test('the table is ordered by canonical name, as docker run --help is', () => {
  const names = DOCKER_RUN_OPTIONS.map(dockerRunOptionName)
  assertEquals(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
})

test('only Windows-only options are marked as a Windows platform', () => {
  const windows = DOCKER_RUN_OPTIONS
    .filter((definition) => definition.platform === 'windows')
    .map(dockerRunOptionName)
  assertEquals(windows.sort(), [
    '--cpu-count',
    '--cpu-percent',
    '--io-maxbandwidth',
    '--io-maxiops',
  ])
  // Every one of them is refused rather than mapped onto a Linux field it
  // does not mean — see the reasons in the registry.
  for (const name of windows) {
    assertEquals(lookupDockerRunOption(name)?.behavior, 'unsupported')
  }
})

test('boolean options never consume the following token', () => {
  // This is the rule that keeps `docker run -d nginx` from reading `nginx` as
  // the value of `-d` and then finding no image at all.
  for (const name of ['-d', '-i', '-t', '--rm', '--privileged', '--init']) {
    assertEquals(lookupDockerRunOption(name)?.value, 'optional', name)
  }
})

test('the security-relevant flags all carry a risk string', () => {
  const risky = [
    '--privileged',
    '--cap-add',
    '--device',
    '--device-cgroup-rule',
    '--pid',
    '--ipc',
    '--network',
    '--userns',
    '--cgroupns',
    '--security-opt',
    '--use-api-socket',
    '--mount',
    '--volume',
  ]
  for (const name of risky) {
    const definition = lookupDockerRunOption(name)
    assertEquals(typeof definition?.risk, 'string', name)
    assertEquals((definition?.risk ?? '').length > 40, true, name)
  }
})
