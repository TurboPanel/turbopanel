import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { dirname, fromFileUrl, join } from '@std/path'
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

  it('reads backticked src, scripts, docs and .github paths of any file type', () => {
    const text =
      'See `src/a/b.ts`, `scripts/x.mjs`, `docs/y.md`, `.github/workflows/ci.yml`, `src/a/`, `src/a/*.ts` and `pnpm src/x`.'
    assertEquals(
      extractReferences(text).map((r) => r.target),
      ['src/a/b.ts', 'scripts/x.mjs', 'docs/y.md', '.github/workflows/ci.yml', 'src/a/']
    )
  })

  it('reports a stale backticked src path as missing and accepts a present one', () => {
    const has = (p: string) => p === '/work/panel/src/a/b.ts'
    assertEquals(status('code', 'src/a/b.ts', 'AGENTS.md', [], has), 'ok')
    assertEquals(status('code', 'src/a/moved.ts', 'AGENTS.md', [], has), 'missing')
  })
})

const scriptPath = join(dirname(fromFileUrl(import.meta.url)), 'check-guide-references.mjs')

async function runInTree(files: Record<string, string>) {
  const root = await Deno.makeTempDir({ prefix: 'tp-guide-references-' })
  try {
    await Deno.mkdir(join(root, 'scripts'), { recursive: true })
    await Deno.copyFile(scriptPath, join(root, 'scripts/check-guide-references.mjs'))
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel)
      await Deno.mkdir(dirname(abs), { recursive: true })
      await Deno.writeTextFile(abs, body)
    }
    const out = await new Deno.Command('node', {
      args: [join(root, 'scripts/check-guide-references.mjs')],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    return {
      code: out.code,
      text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

describe('check-guide-references script', () => {
  it('fails on a stale backticked src path in a guide', async () => {
    const result = await runInTree({
      'src/AGENTS.md': 'The helper lives in `src/lib/gone.ts`.\n',
    })
    assertEquals(result.code, 1)
    assertEquals(result.text.includes('src/AGENTS.md:1: src/lib/gone.ts'), true, result.text)
  })

  it('passes when every backticked src and scripts path exists', async () => {
    const result = await runInTree({
      'src/AGENTS.md': 'See `src/lib/here.ts` and `scripts/check-guide-references.mjs`.\n',
      'src/lib/here.ts': 'export const x = 1\n',
    })
    assertEquals(result.code, 0, result.text)
  })
})
