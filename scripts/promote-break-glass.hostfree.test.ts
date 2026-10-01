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
