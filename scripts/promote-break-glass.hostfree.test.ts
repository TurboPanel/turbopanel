/**
 * The manual promote form is break-glass only: the two automatic PRs
 * (promote-prs.yml -> publish-rc.yml / publish-release.yml) are the normal
 * path, so promote.yml must say so and must never trigger on its own.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

function read(file: string): string {
  return Deno.readTextFileSync(join(repoRoot, file))
}

Deno.test('promote.yml is labelled break-glass and only runs when dispatched by hand', () => {
  const workflow = read('.github/workflows/promote.yml')
  assert(workflow.startsWith('# BREAK-GLASS promotion'))
  const triggers = /^on:\n((?: {2}.*\n|\n)+)/m.exec(workflow)?.[1] ?? ''
  const events = [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1])
  assertEquals(events, ['workflow_dispatch'])
})

Deno.test('the automatic release workflows exist and AGENTS.md calls the form break-glass', () => {
  for (const file of ['promote-prs.yml', 'publish-rc.yml', 'publish-release.yml']) {
    assert(read(`.github/workflows/${file}`).length > 0, file)
  }
  assertStringIncludes(read('AGENTS.md').toLowerCase(), 'break-glass')
})

/** Every TurboPanel/dev reusable workflow and the signer in the three promotion workflows. */
function promotionPins(): { dev: string[]; signer: string[] } {
  const files = ['promote.yml', 'publish-rc.yml', 'publish-release.yml']
  const text = files.map((file) => read(`.github/workflows/${file}`)).join('\n')
  const dev = [
    ...text.matchAll(
      /TurboPanel\/dev\/\.github\/(?:workflows|actions)\/[\w-]+(?:\.yml)?@([0-9a-f]{40})/g
    ),
  ].map((match) => match[1])
  const devRef = [...text.matchAll(/^\s+dev-ref:\s*([0-9a-f]{40})/gm)].map((match) => match[1])
  const signer = [...text.matchAll(/^\s+signer-ref:\s*([0-9a-f]{40})/gm)].map((match) => match[1])
  return { dev: [...dev, ...devRef], signer }
}

Deno.test('the promotion workflows pin ONE dev commit and ONE signer commit', () => {
  const { dev, signer } = promotionPins()
  assert(dev.length >= 9, `expected the dev pins of all three workflows, got ${dev.length}`)
  assertEquals([...new Set(dev)].length, 1, `distinct dev pins: ${[...new Set(dev)].join(', ')}`)
  assert(signer.length >= 3)
  assertEquals(
    [...new Set(signer)].length,
    1,
    `distinct signer pins: ${[...new Set(signer)].join(', ')}`
  )
})
