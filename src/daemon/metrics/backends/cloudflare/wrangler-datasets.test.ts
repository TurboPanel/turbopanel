import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { it } from '@std/testing/bdd'

type WranglerEnv = {
  analytics_engine_datasets?: { binding: string; dataset: string }[]
  vars?: Record<string, string>
}

async function readWrangler(): Promise<{
  analytics_engine_datasets: { binding: string; dataset: string }[]
  env: Record<string, WranglerEnv>
}> {
  const raw = await Deno.readTextFile(new URL('../../../../../wrangler.jsonc', import.meta.url))
  // Only whole-line // comments: strings such as https://… must stay intact.
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
}

it('every deployed environment writes its own Analytics Engine dataset and reads the same one', async () => {
  const wrangler = await readWrangler()
  const seen = new Map<string, string>()
  for (const [name, env] of Object.entries(wrangler.env)) {
    const binding = env.analytics_engine_datasets?.find((d) => d.binding === 'SERVER_METRICS')
    assert(binding, `${name} declares SERVER_METRICS`)
    assertEquals(
      env.vars?.TURBOPANEL_SERVER_METRICS_AE_DATASET,
      binding.dataset,
      `${name}: the read-side var must name the dataset the binding writes`
    )
    assert(/^[a-zA-Z_]\w*$/.test(binding.dataset), `${name}: dataset is a SQL identifier`)
    assert(
      !seen.has(binding.dataset),
      `${name} shares dataset ${binding.dataset} with ${seen.get(binding.dataset)}`
    )
    seen.set(binding.dataset, name)
  }
  assert(seen.size >= 3, 'testing, staging and live are all declared')
  // The top level (local wrangler dev) keeps the bare name and is not an environment.
  const top = wrangler.analytics_engine_datasets.find((d) => d.binding === 'SERVER_METRICS')
  assert(top)
  assertNotEquals(seen.has(top.dataset), true, 'no deployed environment uses the local-dev dataset')
})
