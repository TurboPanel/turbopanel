import { assertEquals } from '@std/assert'
import { applyHostname, ingressProviderFor, preflightHostname } from './registry.ts'
import { hostnameModes, planHostname, type HostnameFacts } from './planner.ts'
import type { IngressContext } from './provider.ts'

const test = Deno.test.bind(Deno)

function facts(over: Partial<HostnameFacts>): HostnameFacts {
  return {
    host: 'panel.example.com',
    mode: 'direct',
    source: 'uploaded',
    publicPort: 8443,
    ...over,
  }
}

function ctx(over: Partial<HostnameFacts>): IngressContext {
  return {
    hostname: {
      ...facts(over),
      id: 'h1',
      uploadedCertId: null,
      status: 'ready',
      notAfter: null,
      acmeLastAttemptAt: null,
      acmeLastError: null,
      isPrimary: true,
      isDaemonDial: false,
      ingressId: null,
    },
  }
}

test('a direct hostname on the default port with an uploaded pair passes', () => {
  assertEquals(planHostname(facts({}), true).ok, true)
})

test('direct refuses another port', () => {
  const plan = planHostname(facts({ publicPort: 443 }), true)
  assertEquals(plan.ok, false)
  assertEquals(plan.checks.find((c) => !c.ok)?.id, 'public-port')
})

test("direct refuses Let's Encrypt for a private name, lan-only refuses it for any name", async () => {
  const direct = await preflightHostname(ctx({ host: 'panel.lan', source: 'lets-encrypt' }))
  assertEquals(direct.checks.find((c) => !c.ok)?.id, 'certificate-issuable')
  const lan = await preflightHostname(ctx({ mode: 'lan-only', source: 'lets-encrypt' }))
  assertEquals(lan.checks.find((c) => !c.ok)?.id, 'certificate-source')
})

test('modes that are not implemented refuse apply', async () => {
  const result = await applyHostname(ctx({ mode: 'cloudflare-tunnel' }))
  assertEquals(result.ok, false)
  assertEquals(result.ok ? '' : result.cause, 'not-available')
  assertEquals((await preflightHostname(ctx({ mode: 'passthrough' }))).ok, false)
})

test('direct and lan-only apply with no stored state', async () => {
  assertEquals(await applyHostname(ctx({})), { ok: true, state: {} })
  assertEquals(await applyHostname(ctx({ mode: 'lan-only' })), { ok: true, state: {} })
  const status = await ingressProviderFor('direct')?.status(ctx({}))
  assertEquals(status?.phase, 'healthy')
})

test('the registry throws on an unknown mode', () => {
  let thrown = false
  try {
    ingressProviderFor('carrier-pigeon')
  } catch (err) {
    thrown = err instanceof TypeError
  }
  assertEquals(thrown, true)
})

test('hostnameModes lists the modes', () => {
  assertEquals(hostnameModes([{ mode: 'direct' }, { mode: 'passthrough' }]), [
    'direct',
    'passthrough',
  ])
})
