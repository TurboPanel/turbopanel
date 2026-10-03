import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { METRICS_SCHEMA_VERSION } from '../../../../contracts/metrics-contract.ts'
import { AE_DATASET_NAME } from './field-map.ts'

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

it('the dataset name tracks the metrics schema version in code and in every wrangler environment', async () => {
  const expected = `turbopanel_server_metrics_v${METRICS_SCHEMA_VERSION}`
  assertEquals(AE_DATASET_NAME, expected)
  const wrangler = await readWrangler()
  const top = wrangler.analytics_engine_datasets.find((d) => d.binding === 'SERVER_METRICS')
  assertEquals(top?.dataset, expected, 'top level (local wrangler dev) keeps the bare name')
  for (const [name, env] of Object.entries(wrangler.env)) {
    const binding = env.analytics_engine_datasets?.find((d) => d.binding === 'SERVER_METRICS')
    assertEquals(binding?.dataset, `${name}_${expected}`, `${name}: binding dataset`)
    assertEquals(
      env.vars?.TURBOPANEL_SERVER_METRICS_AE_DATASET,
      `${name}_${expected}`,
      `${name}: read-side var`
    )
  }
})
