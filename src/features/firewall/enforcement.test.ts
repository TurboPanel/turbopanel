import { assertEquals, assertStringIncludes } from '@std/assert'
import { FIREWALL_APPLY_ENABLED, wireModeFor } from './enforcement.ts'

const test = Deno.test.bind(Deno)

test('enforcement is off in code, so no stored mode can put managed on the wire', () => {
  assertEquals(FIREWALL_APPLY_ENABLED, false)
  assertEquals(wireModeFor('observe'), 'observe')
  assertEquals(wireModeFor('managed'), 'observe')
  assertEquals(wireModeFor('off'), 'observe')
})

test('only the enforcement switch together with a managed server yields managed', () => {
  assertEquals(wireModeFor('managed', true), 'managed')
  assertEquals(wireModeFor('observe', true), 'observe')
})

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory) found.push(...(await sourceFiles(path)))
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) found.push(path)
  }
  return found
}

test('no code path queues server.firewall.reconcile except the preview sender', async () => {
  const senders: string[] = []
  for (const path of await sourceFiles(new URL('../../', import.meta.url).pathname)) {
    const text = await Deno.readTextFile(path)
    if (/createCommandRecord\([^)]*\{[^}]*FIREWALL_RECONCILE_COMMAND/s.test(text))
      senders.push(path)
  }
  assertEquals(senders.length, 1)
  assertEquals(senders[0].endsWith('features/firewall/preview.ts'), true)
})

test('the preview sender takes its mode from wireModeFor and never names managed itself', async () => {
  const text = await Deno.readTextFile(new URL('./preview.ts', import.meta.url))
  assertStringIncludes(text, 'mode: wireModeFor(facts.mode)')
  assertEquals(/mode:\s*['"]managed['"]/.test(text), false)
})
