import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { extractReferences, resolveReference } from './check-guide-references.mjs'

const repoRoot = '/work/panel'
const present = new Set(['/work/panel/docs/setup.md', '/work/panel/src/AGENTS.md'])
const exists = (p: string) => present.has(p)

function status(
  kind: string,
  target: string,
  file = 'src/db/AGENTS.md',
  allowlist: { file: string; target: string; reason: string }[] = [],
  has = exists
) {
  return resolveReference({ kind, target, file, repoRoot, exists: has, allowlist }).status
}

describe('check-guide-references', () => {
  it('accepts a link that resolves relative to the guide', () => {
    assertEquals(status('link', '../AGENTS.md#rules'), 'ok')
  })

  it('reports a missing file', () => {
    assertEquals(status('link', './gone.md'), 'missing')
  })

  it('does not resolve a link against the repo root', () => {
    assertEquals(status('link', 'docs/setup.md'), 'missing')
    assertEquals(status('code', 'docs/setup.md'), 'ok')
  })

  it('skips anchors and external links', () => {
    assertEquals(status('link', '#section'), 'skipped-anchor')
    assertEquals(status('link', 'https://example.com/x'), 'skipped-external')
    assertEquals(status('link', 'mailto:a@example.com'), 'skipped-external')
  })

  it('skips a sibling path when the sibling checkout is absent, checks it when present', () => {
    assertEquals(status('code', '../turbopaneld/src/AGENTS.md', 'AGENTS.md'), 'skipped-sibling')
    const withSibling = (p: string) =>
      p === '/work/turbopaneld' || p === '/work/turbopaneld/src/AGENTS.md'
    assertEquals(status('code', '../turbopaneld/src/AGENTS.md', 'AGENTS.md', [], withSibling), 'ok')
    assertEquals(
      status('code', '../turbopaneld/src/nope.md', 'AGENTS.md', [], withSibling),
      'missing'
    )
  })

  it('lets an allowlisted pointer through', () => {
    const allowlist = [{ file: 'docs/setup.md', target: './console', reason: 'command' }]
    assertEquals(status('code', './console', 'docs/setup.md', allowlist), 'allowlisted')
    assertEquals(status('code', './console', 'docs/other.md', allowlist), 'missing')
  })

  it('extracts links and path-like backticks and ignores code fences and prose', () => {
    const text = [
      'See [setup](./docs/setup.md) and `src/AGENTS.md`, `../ui/x.ts`, `pnpm test`.',
      '```',
      '[ignored](./nope.md)',
      '```',
      'Compose `./data:/data` and `<repo>/x.md` and `../repo/...` are not paths.',
    ].join('\n')
    assertEquals(
      extractReferences(text).map((r) => `${r.line}:${r.kind}:${r.target}`),
      ['1:link:./docs/setup.md', '1:code:src/AGENTS.md', '1:code:../ui/x.ts']
    )
  })
})
