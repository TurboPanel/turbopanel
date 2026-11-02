/**
 * The contract-twin sibling ref: same-named branch by default, an optional
 * `Sibling-Branch:` line in the pull request description, trunk for
 * promotion pull requests, and the build.yml wiring that keeps the
 * description out of the shell.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  isSafeBranchName,
  parseSiblingBranch,
  resolveSiblingRef,
  summaryMarkdown,
} from './resolve-sibling-ref.mjs'

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

/** The error text of a parse or resolve result ('' when it succeeded). */
const errorOf = (result: object): string =>
  'error' in result && typeof result.error === 'string' ? result.error : ''

describe('resolveSiblingRef', () => {
  it('keeps the default: the same-named branch when the description has no override', () => {
    assertEquals(resolveSiblingRef({ headRef: 'feat/x', baseRef: 'trunk', prBody: 'Summary' }), {
      candidate: 'feat/x',
      source: 'same-name',
    })
    assertEquals(resolveSiblingRef({ headRef: 'trunk', baseRef: '', prBody: '' }), {
      candidate: 'trunk',
      source: 'same-name',
    })
    assertEquals(resolveSiblingRef({ headRef: '', baseRef: '', prBody: '' }), {
      candidate: 'trunk',
      source: 'same-name',
    })
  })

  it('uses the Sibling-Branch line when present', () => {
    const prBody = 'Summary\r\n\r\nSibling-Branch: feat/daemon-side\r\n'
    assertEquals(resolveSiblingRef({ headRef: 'patch-1', baseRef: 'trunk', prBody }), {
      candidate: 'feat/daemon-side',
      source: 'override',
    })
    assertEquals(
      resolveSiblingRef({ headRef: 'patch-1', baseRef: 'trunk', prBody: 'sibling-branch:x.y' }),
      { candidate: 'x.y', source: 'override' }
    )
    // An indented line (a code block example) is not an override.
    assertEquals(
      resolveSiblingRef({
        headRef: 'patch-1',
        baseRef: 'trunk',
        prBody: '    Sibling-Branch: a b',
      }),
      { candidate: 'patch-1', source: 'same-name' }
    )
  })

  it('always uses trunk for promotion pull requests, even with an override', () => {
    const prBody = 'Sibling-Branch: feat/x'
    for (const [headRef, baseRef] of [
      ['trunk', 'staging'],
      ['staging', 'live'],
      ['staging', 'trunk'],
      ['live', ''],
    ]) {
      assertEquals(resolveSiblingRef({ headRef, baseRef, prBody }), {
        candidate: 'trunk',
        source: 'promotion',
      })
    }
  })

  it('refuses an unsafe or repeated override without echoing it', () => {
    const hostile = 'Sibling-Branch: x$(curl evil)`id`'
    const result = resolveSiblingRef({ headRef: 'a', baseRef: 'trunk', prBody: hostile })
    assertStringIncludes(errorOf(result), 'not a plain branch')
    assert(!errorOf(result).includes('curl'))
    const twice = 'Sibling-Branch: a\nSibling-Branch: b'
    assertStringIncludes(errorOf(parseSiblingBranch(twice)), 'more than one')
    assertStringIncludes(errorOf(parseSiblingBranch('Sibling-Branch:')), 'not a plain branch')
  })
})

describe('isSafeBranchName', () => {
  it('accepts plain branch names', () => {
    for (const name of ['trunk', 'feat/x', 'fix/a.b_c-d', 'a'.repeat(100)]) {
      assert(isSafeBranchName(name), name)
    }
  })

  it('rejects anything else', () => {
    for (const name of [
      '',
      'a'.repeat(101),
      'a b',
      'a;b',
      'a\nb',
      '$x',
      '-x',
      '.x',
      '/x',
      'x/',
      'x.',
      'x.lock',
      'a..b',
      'a//b',
      'a/.b',
      'refs:heads',
    ]) {
      assert(!isSafeBranchName(name), JSON.stringify(name))
    }
    assert(!isSafeBranchName(undefined))
  })
})

describe('summaryMarkdown', () => {
  const siblingRepo = 'TurboPanel/turbopaneld'

  it('names the ref and the merge order for a twin', () => {
    const text = summaryMarkdown({ siblingRepo, ref: 'feat/x', source: 'override' })
    assertStringIncludes(text, '`TurboPanel/turbopaneld` at `feat/x`')
    assertStringIncludes(text, 'Sibling-Branch line')
    assertStringIncludes(text, 'merge the turbopanel pull request first')
  })

  it('explains the override when it fell back to trunk', () => {
    const text = summaryMarkdown({ siblingRepo, ref: 'trunk', source: 'trunk-fallback' })
    assertStringIncludes(text, 'Sibling-Branch: <branch>')
    assert(!text.includes('merge the turbopanel pull request first'))
  })
})

describe('build.yml wiring', () => {
  const build = Deno.readTextFileSync(join(repoRoot, '.github/workflows/build.yml'))

  it('reads the description through the environment only', () => {
    assert(!/\$\{\{\s*github\.event\.pull_request\.body/.test(build.replace(/EVENT_BODY: .*/, '')))
    assertStringIncludes(build, 'EVENT_BODY: ${{ github.event.pull_request.body }}')
    assertStringIncludes(build, 'node turbopanel/scripts/resolve-sibling-ref.mjs')
  })

  it('notes a skipped code scan on fork pull requests', () => {
    assertStringIncludes(build, 'name: Note a skipped code scan')
    assertStringIncludes(build, '::notice title=Code scan skipped::')
  })
})
