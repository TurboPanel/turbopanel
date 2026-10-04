/**
 * CI shard partition for the Deno coverage run, and the build.yml shape
 * that fans those shards back into the required SonarQube check.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  API_ROUTES_FILE,
  EXCLUDED,
  SHARD_NAMES,
  denoSuites,
  isHostfreeName,
  isWorkersSuite,
  partitionDenoShards,
  weight,
} from './deno-test-shards.mjs'

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

describe('deno-test-shards', () => {
  it('puts every Deno suite in exactly one shard', () => {
    const parts = partitionDenoShards(repoRoot) as Record<string, string[]>
    const seen = new Map<string, string>()
    for (const name of SHARD_NAMES) {
      const files = parts[name]
      if (!files) throw new TypeError(`missing shard ${name}`)
      for (const file of files) {
        const prior = seen.get(file)
        assertEquals(prior, undefined, `${file} is in ${prior} and ${name}`)
        seen.set(file, name)
      }
    }
    assertEquals(seen.size, denoSuites(repoRoot).length)
    for (const file of denoSuites(repoRoot)) {
      assert(seen.has(file), `${file} is not in a shard`)
    }
  })

  it('keeps api-routes alone and host-free names off the database shards', () => {
    const parts = partitionDenoShards(repoRoot) as Record<string, string[]>
    assertEquals(parts['api-routes'], [API_ROUTES_FILE])
    const hostfree = parts.hostfree
    if (!hostfree) throw new TypeError('missing hostfree shard')
    for (const file of hostfree) {
      assert(isHostfreeName(file))
      assertEquals(file === API_ROUTES_FILE, false)
    }
    for (const name of ['db-1', 'db-2'] as const) {
      const files = parts[name]
      if (!files) throw new TypeError(`missing shard ${name}`)
      for (const file of files) {
        assertEquals(isHostfreeName(file), false)
        assertEquals(isWorkersSuite(file), false)
        assertEquals(EXCLUDED.has(file), false)
      }
    }
  })

  it('splits the two heaviest database suites onto different runners', () => {
    const parts = partitionDenoShards(repoRoot) as Record<string, string[]>
    const ranked = [...(parts['db-1'] ?? []), ...(parts['db-2'] ?? [])].sort((a, b) => {
      const delta = weight(b) - weight(a)
      return delta === 0 ? a.localeCompare(b) : delta
    })
    assert(ranked.length > 1)
    const db1 = parts['db-1']
    if (!db1) throw new TypeError('missing db-1 shard')
    const heaviest = ranked[0]
    const next = ranked[1]
    if (heaviest === undefined || next === undefined) {
      throw new TypeError('expected two database suites')
    }
    const shardOf = (file: string) => (db1.includes(file) ? 'db-1' : 'db-2')
    assertEquals(shardOf(heaviest) === shardOf(next), false)
  })

  it('ignores the same service-dependent files as test-coverage.sh', () => {
    const shell = Deno.readTextFileSync(join(repoRoot, 'scripts/test-coverage.sh'))
    const ignores = [...shell.matchAll(/^  --ignore=(\S+)/gm)].map((match) => match[1])
    const files = ignores
      .filter((entry): entry is string => entry !== undefined && !entry.includes('*'))
      .sort((a, b) => a.localeCompare(b))
    const excluded = [...EXCLUDED].sort((a, b) => a.localeCompare(b))
    assertEquals(files, excluded)
    const lines = shell.split('\n')
    const start = lines.findIndex((line) => line.trimStart().startsWith('deno test '))
    assert(start >= 0)
    let end = start
    for (let i = start; i < lines.length; i++) {
      end = i
      if (!lines[i]?.trimEnd().endsWith('\\')) break
    }
    const block = lines.slice(start, end + 1).join('\n')
    assertStringIncludes(block, '\n  src/')
    assertStringIncludes(block, '\n  scripts/')
  })
})

describe('build.yml fan-in', () => {
  const workflow = Deno.readTextFileSync(join(repoRoot, '.github/workflows/build.yml'))

  it('keeps the required check named SonarQube and cancels only stale PR runs', () => {
    assertStringIncludes(workflow, 'name: SonarQube')
    // SonarQube needs only the coverage shards and is skipped (not failed)
    // when one of them did not succeed; ci-ok is what fails for that.
    assertStringIncludes(workflow, 'needs: [vitest, deno-hostfree, deno-db]')
    for (const shard of ['vitest', 'deno-hostfree', 'deno-db']) {
      assertStringIncludes(workflow, `needs.${shard}.result == 'success'`)
    }
    assertEquals(workflow.includes('Fail unless every upstream job succeeded'), false)
    // Build scans pull requests only and waits for their gate; a trunk push
    // only uploads the merged LCOV (sonar-trunk.yml analyses it), so Sonar
    // never holds back the canary.
    assertStringIncludes(workflow, "&& github.event_name == 'pull_request'")
    assertStringIncludes(workflow, '-Dsonar.qualitygate.wait=true')
    assertStringIncludes(workflow, 'name: instance-coverage-lcov')
    // ci-ok: a cancelled PR run still fails it; a cancelled push run skips it.
    assertStringIncludes(workflow, "(github.event_name == 'pull_request' && always())")
    assertStringIncludes(workflow, "!contains(needs.*.result, 'cancelled')")
    assertStringIncludes(workflow, 'all(.value.result == "success")')
    assertStringIncludes(workflow, 'shard: [api-routes, db-1, db-2]')
    assertStringIncludes(workflow, 'DENO_SHARD: hostfree')
    assertStringIncludes(workflow, 'TEST_PHASE: vitest')
    // Pull requests replace a superseded run; trunk pushes queue instead, so
    // every merged commit is tested and gets a canary.
    const cancelLines = workflow
      .split('\n')
      .filter((line) => line.trimStart().startsWith('cancel-in-progress:'))
    assert(cancelLines.length >= 5)
    // The trunk -> staging and staging -> live promotion PRs are never
    // cancelled either (each head is a real commit; a cancelled run is a red
    // mark on it): their groups end in the run id instead of the ref.
    for (const line of cancelLines) {
      assertStringIncludes(
        line,
        "cancel-in-progress: ${{ github.event_name == 'pull_request' && github.head_ref != 'trunk' && github.head_ref != 'staging' }}"
      )
    }
    const groupLines = workflow.split('\n').filter((line) => line.trimStart().startsWith('group:'))
    assert(groupLines.length >= 5)
    for (const line of groupLines) {
      assertStringIncludes(
        line,
        "(github.head_ref == 'trunk' || github.head_ref == 'staging') && github.run_id || github.ref"
      )
    }
    assertStringIncludes(
      workflow,
      "queue: ${{ github.event_name == 'pull_request' && 'single' || 'max' }}"
    )
  })

  it('pairs sibling checkouts with trunk, never staging or live', () => {
    const guard = 'staging:* | live:* | *:staging | *:live) REF=trunk ;;'
    assertEquals(workflow.split(guard).length - 1, 1)
    assertEquals(workflow.includes('REF="${{'), false)
  })

  it('does not depend on the website checkout or a generated data dictionary', () => {
    assertEquals(workflow.includes('repository: TurboPanel/website'), false)
    assertEquals(workflow.includes('data-dictionary'), false)
  })
})

describe('sonar-trunk.yml', () => {
  const workflow = Deno.readTextFileSync(join(repoRoot, '.github/workflows/sonar-trunk.yml'))

  it('analyses the trunk commit Build tested, beside the canary', () => {
    assertStringIncludes(workflow, 'name: Sonar Trunk Analysis')
    assertStringIncludes(workflow, 'workflows: [Build]')
    assertStringIncludes(workflow, 'branches: [trunk]')
    // Same filter as canary.yml: never the trunk -> staging PR's Build.
    assertStringIncludes(workflow, "github.event.workflow_run.event == 'push'")
    assertStringIncludes(workflow, "github.event.workflow_run.event == 'workflow_dispatch'")
    // The LCOV Build merged, from that Build run.
    assertStringIncludes(workflow, 'name: instance-coverage-lcov')
    assertStringIncludes(workflow, 'run-id: ${{ github.event.workflow_run.id }}')
    // The Build's commit, not GITHUB_SHA (the tip of trunk by the time it runs).
    assertStringIncludes(workflow, 'ref: ${{ github.event.workflow_run.head_sha }}')
    assertStringIncludes(workflow, 'fetch-depth: 0')
    assertStringIncludes(workflow, '-Dsonar.branch.name=trunk')
    assertStringIncludes(workflow, '-Dsonar.scm.revision=${{ github.event.workflow_run.head_sha }}')
    assertStringIncludes(workflow, '-Dsonar.qualitygate.wait=false')
    // Every trunk commit keeps its analysis: queued in order, never cancelled.
    assertStringIncludes(workflow, 'cancel-in-progress: false')
    assertStringIncludes(workflow, 'queue: max')
    assertStringIncludes(workflow, 'permissions: {}')
  })
})
