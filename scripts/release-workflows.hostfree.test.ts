/**
 * Shape rules for the release workflows since versions come from git tags
 * (Road to 0.2.x, versioning Phase 3): no workflow opens a "Start x.y.z" PR or
 * gates on a minor, no release step takes its version from deno.json, and the
 * build stamps the tag-derived base into deno.json before compiling (minors
 * and majors are started by turbopaneld's "Start Next Version" workflow).
 */
import { assert, assertEquals, assertMatch } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WORKFLOWS = join(dirname(dirname(fromFileUrl(import.meta.url))), '.github', 'workflows')

function read(name: string): string {
  return Deno.readTextFileSync(join(WORKFLOWS, name))
}

function workflowFiles(): string[] {
  return [...Deno.readDirSync(WORKFLOWS)]
    .filter((entry) => entry.isFile && entry.name.endsWith('.yml'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

const GONE = [
  /gh-next-version/,
  /gh-minor-gate|minor-gate/,
  /start-minor/,
  /--label minor/,
  /--title "Start /,
]

test('no workflow opens a Start PR or gates on a minor', () => {
  const files = workflowFiles()
  assert(files.length > 0)
  for (const file of files) {
    const text = read(file)
    for (const gone of GONE) {
      assert(!gone.test(text), `${file} still matches ${gone}`)
    }
  }
})

test('no release step takes its version from deno.json', () => {
  for (const file of workflowFiles()) {
    const text = read(file)
    assert(!/contents\/deno\.json/.test(text), `${file} reads deno.json from the API`)
    assert(!/version-file:/.test(text), `${file} passes a version file`)
    assert(!/GITHUB_RUN_NUMBER/.test(text), `${file} numbers a canary by run`)
  }
})

test('the canary build works out its version from the tags and stamps the base before compiling', () => {
  const text = read('release.yml')
  assertMatch(
    text,
    /uses: TurboPanel\/dev\/\.github\/actions\/version@[0-9a-f]{40} # dev#\d+\n {8}with:\n {10}mode: canary\n/
  )
  assertMatch(text, /^ {6}base: \$\{\{ steps\.resolve\.outputs\.base \}\}$/m)
  assertMatch(text, /^ {6}TP_BASE_VERSION: \$\{\{ needs\.prepare\.outputs\.base \}\}$/m)
  const stamp = text.indexOf('- name: Stamp the build identity')
  const compile = text.indexOf('- name: Compile the instance')
  assert(stamp > 0 && stamp < compile)
  assert(text.slice(stamp, compile).includes('for path in ("deno.json", "package.json"):'))
  assert(
    !text.includes('Require the tag to match deno.json'),
    'a tag no longer has to match deno.json'
  )
})

test('publish-rc hands gh-promote the canary found by commit, not a run number', () => {
  const text = read('publish-rc.yml')
  assertMatch(text, /^ {6}source: \$\{\{ needs\.resolve\.outputs\.canary \}\}$/m)
  assert(!text.includes('outputs.build'))
})

test('the promotion workflows pin one TurboPanel/dev commit', () => {
  const pins = new Set<string>()
  for (const file of [
    'publish-rc.yml',
    'publish-release.yml',
    'promote-prs.yml',
    'promote-ok.yml',
    'promote-ok-recheck.yml',
  ]) {
    const text = read(file)
    for (const m of text.matchAll(
      /TurboPanel\/dev\/\.github\/(?:workflows\/[\w.-]+|actions\/version)@([0-9a-f]{40})/g
    )) {
      pins.add(m[1])
    }
    for (const m of text.matchAll(/^ +(?:dev-)?ref: ([0-9a-f]{40})(?: #.*)?$/gm)) {
      pins.add(m[1])
    }
  }
  assertEquals(pins.size, 1, `pins: ${[...pins].join(', ')}`)
})
