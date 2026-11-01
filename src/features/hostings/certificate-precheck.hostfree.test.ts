import { assertEquals } from '@std/assert'
import {
  caaSetAllowsLetsEncrypt,
  checkCaa,
  parseCaaData,
  precheckProbes,
  addressPort80Probe,
  namePort80Probe,
} from './certificate-precheck.ts'

const test = Deno.test.bind(Deno)

test('CAA answers parse in both the readable and the generic form', () => {
  assertEquals(parseCaaData('0 issue "letsencrypt.org"'), {
    critical: false,
    tag: 'issue',
    value: 'letsencrypt.org',
  })
  // flags 0, tag length 5, "issue", "ca.example"
  assertEquals(parseCaaData('\\# 17 00 05 69 73 73 75 65 63 61 2e 65 78 61 6d 70 6c 65'), {
    critical: false,
    tag: 'issue',
    value: 'ca.example',
  })
  assertEquals(parseCaaData('nonsense'), null)
})

test('CAA rules: no issue record allows, an empty issue value forbids, an unknown critical tag forbids', () => {
  assertEquals(caaSetAllowsLetsEncrypt([]), true)
  assertEquals(caaSetAllowsLetsEncrypt([{ critical: false, tag: 'iodef', value: 'x' }]), true)
  assertEquals(caaSetAllowsLetsEncrypt([{ critical: false, tag: 'issue', value: ';' }]), false)
  assertEquals(caaSetAllowsLetsEncrypt([{ critical: true, tag: 'future', value: 'x' }]), false)
  assertEquals(
    caaSetAllowsLetsEncrypt([{ critical: false, tag: 'issue', value: 'LetsEncrypt.org' }]),
    true
  )
})

test('the closest name with CAA records decides, and a failed lookup is unknown', async () => {
  const seen: string[] = []
  const verdict = await checkCaa((name) => {
    seen.push(name)
    return Promise.resolve(
      name === 'b.example.com' ? [{ critical: false, tag: 'issue', value: 'letsencrypt.org' }] : []
    )
  }, 'a.b.example.com')
  assertEquals(verdict, { allowed: true })
  assertEquals(seen, ['a.b.example.com', 'b.example.com'])
  assertEquals(await checkCaa(() => Promise.reject(new Error('SERVFAIL')), 'a.example.com'), {
    allowed: null,
  })
})

test('port 80 by name (Workers): any answer is open, a refusal or an origin-unreachable answer is closed, a timeout is unknown', async () => {
  const answering = namePort80Probe(() => Promise.resolve(new Response('nope', { status: 404 })))
  assertEquals(await answering('a.example.com', []), { state: 'open' })
  const proxyDown = namePort80Probe(() => Promise.resolve(new Response('', { status: 521 })))
  assertEquals(await proxyDown('a.example.com', []), {
    state: 'closed',
    error: 'no answer on port 80 (HTTP 521)',
  })
  const refused = namePort80Probe(() =>
    Promise.reject(
      new TypeError('fetch failed', { cause: new Error('Connection refused (os error 111)') })
    )
  )
  assertEquals(await refused('a.example.com', []), {
    state: 'closed',
    error: 'fetch failed: Connection refused (os error 111)',
  })
  const slow = namePort80Probe(() => Promise.reject(new DOMException('timed out', 'TimeoutError')))
  assertEquals((await slow('a.example.com', [])).state, 'unknown')
})

test('port 80 by address (Deno): dials each exact address; only a refusal is closed, anything else unknown', async () => {
  const dialed: string[] = []
  const refusing = (name: string) =>
    Object.assign(new Error(`refused ${name}`), { name: 'ConnectionRefused' })
  const probe = addressPort80Probe(({ hostname }) => {
    dialed.push(hostname)
    if (hostname === '198.51.100.9') return Promise.reject(refusing(hostname))
    if (hostname === '2001:db8::9') return Promise.reject(new Error('Network is unreachable'))
    return Promise.resolve({ close: () => {} })
  })
  assertEquals((await probe('a.example.com', ['198.51.100.7'])).state, 'open')
  const v6only = await probe('a.example.com', ['2001:db8::9'])
  assertEquals(v6only.state, 'unknown')
  const nat = await probe('a.example.com', ['198.51.100.9', '198.51.100.7'])
  assertEquals([nat.state, nat.address], ['closed', '198.51.100.9'])
  assertEquals(dialed.includes('a.example.com'), false)
})

test('CAA never asks the top-level domain', async () => {
  const seen: string[] = []
  await checkCaa((name) => {
    seen.push(name)
    return Promise.resolve([])
  }, 'a.example.com')
  assertEquals(seen, ['a.example.com', 'example.com'])
})

test('an injected DNS lookup turns the network probes off unless they are injected too', () => {
  assertEquals(precheckProbes({ lookup: () => Promise.resolve([]) }), {})
  const port80 = () => Promise.resolve({ state: 'open' as const })
  assertEquals(precheckProbes({ lookup: () => Promise.resolve([]), port80 }), { port80 })
})
