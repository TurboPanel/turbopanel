import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  applyAllowedFor,
  DENY_FIREWALL_APPLY,
  FIREWALL_APPLY_ENABLED,
  FIREWALL_APPLY_SERVERS_ENV,
  FIREWALL_APPLY_SERVERS_MAX,
  firewallApplyGateFromEnv,
  parseFirewallApplyServers,
  wireModeFor,
} from './enforcement.ts'

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

const HOST_A = '0192d6a0-0000-7000-8000-00000000000a'
const HOST_B = '0192d6a0-0000-7000-8000-00000000000b'

test('by default no server may apply: no env, an empty env, or no gate at all', () => {
  assertEquals(applyAllowedFor(HOST_A, undefined), false)
  assertEquals(applyAllowedFor(HOST_A, DENY_FIREWALL_APPLY), false)
  assertEquals(applyAllowedFor(HOST_A, firewallApplyGateFromEnv(undefined)), false)
  assertEquals(applyAllowedFor(HOST_A, firewallApplyGateFromEnv({})), false)
  assertEquals(
    applyAllowedFor(HOST_A, firewallApplyGateFromEnv({ [FIREWALL_APPLY_SERVERS_ENV]: '' })),
    false
  )
})

test('naming one server allows that server only; every other server stays observe-only', () => {
  const gate = firewallApplyGateFromEnv({
    [FIREWALL_APPLY_SERVERS_ENV]: ` ${HOST_A.toUpperCase()} `,
  })
  assertEquals(applyAllowedFor(HOST_A, gate), true)
  assertEquals(applyAllowedFor(HOST_B, gate), false)
  assertEquals(wireModeFor('managed', applyAllowedFor(HOST_B, gate)), 'observe')
})

test('the hosted live environment never honors the allowlist; testing and self-hosted do', () => {
  const named = { [FIREWALL_APPLY_SERVERS_ENV]: HOST_A }
  for (const environment of ['live', ' LIVE ']) {
    const gate = firewallApplyGateFromEnv({ ...named, TURBOPANEL_ENVIRONMENT: environment })
    assertEquals(applyAllowedFor(HOST_A, gate), false, environment)
  }
  const testing = firewallApplyGateFromEnv({ ...named, TURBOPANEL_ENVIRONMENT: 'testing' })
  assertEquals(applyAllowedFor(HOST_A, testing), true)
  assertEquals(applyAllowedFor(HOST_A, firewallApplyGateFromEnv(named)), true)
})

test('a wildcard, a malformed entry or too many servers closes the switch for everyone', () => {
  for (const raw of [
    '*',
    'all',
    'true',
    '1',
    `${HOST_A},*`,
    `${HOST_A},not-a-uuid`,
    `${HOST_A};${HOST_B}`,
  ]) {
    assertEquals(parseFirewallApplyServers(raw).size, 0, raw)
  }
  const many = Array.from(
    { length: FIREWALL_APPLY_SERVERS_MAX + 1 },
    (_, index) => `0192d6a0-0000-7000-8000-${String(index).padStart(12, '0')}`
  )
  assertEquals(parseFirewallApplyServers(many.join(',')).size, 0)
  assertEquals(
    parseFirewallApplyServers(many.slice(0, FIREWALL_APPLY_SERVERS_MAX).join(',')).size,
    3
  )
})

test('no committed Workers config sets the apply allowlist (turning it on is an operator act)', async () => {
  const root = new URL('../../../', import.meta.url)
  for await (const entry of Deno.readDir(root)) {
    if (!/^wrangler.*\.jsonc?$/.test(entry.name)) continue
    const text = await Deno.readTextFile(new URL(entry.name, root))
    assertEquals(text.includes(FIREWALL_APPLY_SERVERS_ENV), false, entry.name)
  }
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
  assertStringIncludes(text, 'wireModeFor(stored, options.applyAllowed === true)')
  assertStringIncludes(text, 'applyAllowed: applyAllowedFor(serverId, options.applyGate)')
  assertEquals(/mode:\s*['"]managed['"]/.test(text), false)
})
