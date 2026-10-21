/**
 * scripts/set-version.mjs: rewrites the committed version in place, refuses a
 * version that is not plain X.Y.Z, and `--check` changes nothing.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { disagreement, isPlainVersion, run, VERSION_FILES } from './set-version.mjs'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

const DENO_JSON = `{
  "name": "@turbopanel/instance",
  "version": "0.1.5",
  "imports": {
    "x": "npm:x@1.2.3"
  }
}
`
const PACKAGE_JSON = `{
  "name": "instance",
  "version": "0.1.5",
  "dependencies": { "y": "^4.5.6", "version": "0.0.1" },
  "pnpm": {
    "version": "0.0.2"
  }
}
`
const SONAR = `sonar.projectKey=TurboPanel_turbopanel
sonar.projectName=turbopanel
sonar.projectVersion=0.1.5
sonar.sources=src
`

function fixture(): string {
  const dir = Deno.makeTempDirSync({ prefix: 'set-version-' })
  Deno.writeTextFileSync(join(dir, 'deno.json'), DENO_JSON)
  Deno.writeTextFileSync(join(dir, 'package.json'), PACKAGE_JSON)
  Deno.writeTextFileSync(join(dir, 'sonar-project.properties'), SONAR)
  return dir
}

function runIn(root: string, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = run(argv, {
    root,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  })
  return { code, out, err }
}

function read(root: string, path: string): string {
  return Deno.readTextFileSync(join(root, path))
}

test('accepts only a plain X.Y.Z', () => {
  for (const ok of ['0.1.9', '1.0.0', '10.20.30']) assert(isPlainVersion(ok), ok)
  for (const bad of ['v0.1.9', '0.1.9-rc.1', '0.1.9-canary.3', '0.1', '0.1.9.1', '', ' 0.1.9']) {
    assert(!isPlainVersion(bad), bad)
  }
})

test('sets every file and changes only the version value', () => {
  const root = fixture()
  const { code, out } = runIn(root, ['0.1.9'])
  assertEquals(code, 0)
  assertEquals(out.length, 3)
  assertEquals(read(root, 'deno.json'), DENO_JSON.replace('"0.1.5"', '"0.1.9"'))
  assertEquals(read(root, 'package.json'), PACKAGE_JSON.replace('"0.1.5"', '"0.1.9"'))
  assertEquals(
    read(root, 'sonar-project.properties'),
    SONAR.replace('projectVersion=0.1.5', 'projectVersion=0.1.9')
  )
  // A nested "version" key is not the package version.
  assertEquals(JSON.parse(read(root, 'package.json')).dependencies.version, '0.0.1')
  assertEquals(JSON.parse(read(root, 'package.json')).pnpm.version, '0.0.2')
})

test('setting the version it already has writes nothing', () => {
  const root = fixture()
  const { code, out } = runIn(root, ['0.1.5'])
  assertEquals(code, 0)
  assertEquals(out, [])
})

test('refuses a version that is not plain X.Y.Z and writes nothing', () => {
  const root = fixture()
  for (const argv of [
    ['0.1.9-rc.1'],
    ['v0.1.9'],
    ['--check', '0.1.9-canary.2'],
    [],
    ['0.1.9', '0.2.0'],
  ]) {
    const { code } = runIn(root, argv)
    assertEquals(code, 2, argv.join(' '))
  }
  assertEquals(read(root, 'deno.json'), DENO_JSON)
})

test('--check names each file that disagrees and changes nothing', () => {
  const root = fixture()
  const { code, err } = runIn(root, ['--check', '0.1.9'])
  assertEquals(code, 1)
  assertEquals(err, [
    disagreement('deno.json', '0.1.5', '0.1.9'),
    disagreement('package.json', '0.1.5', '0.1.9'),
    disagreement('sonar-project.properties', '0.1.5', '0.1.9'),
  ])
  assertStringIncludes(err[0], 'deno.json says 0.1.5, the next version is 0.1.9')
  assertStringIncludes(err[0], 'merge the "chore: start 0.1.9" PR')
  assertEquals(read(root, 'deno.json'), DENO_JSON)
  assertEquals(read(root, 'sonar-project.properties'), SONAR)
})

test('--check passes once the files agree', () => {
  const root = fixture()
  assertEquals(runIn(root, ['0.1.9']).code, 0)
  const { code, err } = runIn(root, ['--check', '0.1.9'])
  assertEquals(code, 0)
  assertEquals(err, [])
})

test('a missing version field fails and writes nothing', () => {
  const root = fixture()
  Deno.writeTextFileSync(join(root, 'sonar-project.properties'), 'sonar.projectKey=x\n')
  const { code, err } = runIn(root, ['0.1.9'])
  assertEquals(code, 1)
  assertEquals(err, ['sonar-project.properties: no version field found'])
  assertEquals(read(root, 'deno.json'), DENO_JSON)
})

test('the repo files are the ones the script knows and agree with each other', () => {
  assertEquals(
    VERSION_FILES.map((f: { path: string }) => f.path),
    ['deno.json', 'package.json', 'sonar-project.properties']
  )
  const version = JSON.parse(read(repoRoot, 'deno.json')).version
  assertEquals(runIn(repoRoot, ['--check', version]).code, 0)
})

test('through a symlink it checks the real repo, under node and deno', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'set-version-link-' })
  try {
    const link = join(dir, 'set-version.mjs')
    Deno.symlinkSync(join(repoRoot, 'scripts', 'set-version.mjs'), link)
    const version = JSON.parse(read(repoRoot, 'deno.json')).version
    const runtimes = [['node'], [Deno.execPath(), 'run', '--no-config', '--allow-read']]
    for (const [cmd, ...pre] of runtimes) {
      const run = (v: string) =>
        new Deno.Command(cmd, {
          args: [...pre, link, '--check', v],
          stdout: 'piped',
          stderr: 'piped',
        }).outputSync()
      assertEquals(run(version).code, 0, cmd)
      const bad = run('0.0.0')
      assertEquals(bad.code, 1, cmd)
      assertStringIncludes(new TextDecoder().decode(bad.stderr), 'chore: start 0.0.0')
    }
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})
