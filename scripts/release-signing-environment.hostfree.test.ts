/**
 * Road to 0.2.x row r2-signing-key-environment: the release signing key is an
 * environment secret, so only a job that names a GitHub environment can read
 * it. A job that reads it without declaring one would sign with a plain
 * repo-level secret that any code on a trunk workflow could use.
 */
import { assert } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { parse } from 'yaml'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WORKFLOWS = join(dirname(dirname(fromFileUrl(import.meta.url))), '.github', 'workflows')

type Job = { environment?: unknown; uses?: unknown; secrets?: unknown } & Record<string, unknown>

function workflowJobs(file: string): Array<[string, Job]> {
  const doc = parse(Deno.readTextFileSync(join(WORKFLOWS, file))) as {
    jobs?: Record<string, Job>
  }
  return Object.entries(doc.jobs ?? {})
}

const SIGNING_SECRET = /secrets\.[A-Z_]*SIGNING_KEY/

test('every job that reads a signing-key secret names a GitHub environment', () => {
  let readers = 0
  for (const entry of Deno.readDirSync(WORKFLOWS)) {
    if (!entry.isFile || !entry.name.endsWith('.yml')) continue
    for (const [jobName, job] of workflowJobs(entry.name)) {
      if (!SIGNING_SECRET.test(JSON.stringify(job))) continue
      readers++
      const environment = job.environment
      assert(
        typeof environment === 'string' && environment.length > 0,
        `${entry.name} job ${jobName} reads the signing key but declares no environment`
      )
    }
  }
  assert(readers > 0, 'no job reads the signing key: the scan found nothing')
})

test('the live-channel signing job resolves to the protected release environment', () => {
  const signing = workflowJobs('release.yml').find(([, job]) =>
    SIGNING_SECRET.test(JSON.stringify(job))
  )
  assert(signing, 'release.yml has no signing job')
  assert(
    String(signing[1].environment).includes("'release'"),
    "release.yml's signing job must resolve to the `release` environment for the live channel"
  )
})

test('callers of release workflows inherit secrets, and nothing falls back to a repo-level signing key', () => {
  for (const entry of Deno.readDirSync(WORKFLOWS)) {
    if (!entry.isFile || !entry.name.endsWith('.yml')) continue
    const text = Deno.readTextFileSync(join(WORKFLOWS, entry.name))
    assert(
      !text.includes('secrets.RELEASE_SIGNING_KEY'),
      `${entry.name} falls back to a repo-level RELEASE_SIGNING_KEY`
    )
    // An environment secret evaluates empty in a called workflow unless the caller passes secrets
    // down (ui#164 broke canary signing by dropping `inherit`; ui#169 restored it).
    for (const [jobName, job] of workflowJobs(entry.name)) {
      const uses = String(job.uses ?? '')
      if (!/release\.yml$|gh-promote\.yml@/.test(uses)) continue
      assert(
        job.secrets === 'inherit',
        `${entry.name} job ${jobName} must pass \`secrets: inherit\``
      )
    }
  }
})
