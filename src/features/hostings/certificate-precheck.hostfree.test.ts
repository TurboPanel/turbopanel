import { assertEquals } from '@std/assert'
import {
  caaSetAllowsLetsEncrypt,
  checkCaa,
  parseCaaData,
  precheckProbes,
  runtimePort80Probe,
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

test('port 80: any answer is reachable; a refused connection or an origin-unreachable answer is not', async () => {
  const answering = runtimePort80Probe(() => Promise.resolve(new Response('nope', { status: 404 })))
  assertEquals(await answering('a.example.com'), { open: true })
  const proxyDown = runtimePort80Probe(() => Promise.resolve(new Response('', { status: 521 })))
  assertEquals((await proxyDown('a.example.com')).open, false)
  const refused = runtimePort80Probe(() =>
    Promise.reject(
      new TypeError('fetch failed', { cause: new Error('Connection refused (os error 111)') })
    )
  )
  assertEquals(await refused('a.example.com'), {
    open: false,
    error: 'fetch failed: Connection refused (os error 111)',
  })
})

test('an injected DNS lookup turns the network probes off unless they are injected too', () => {
  assertEquals(precheckProbes({ lookup: () => Promise.resolve([]) }), {})
  const port80 = () => Promise.resolve({ open: true })
  assertEquals(precheckProbes({ lookup: () => Promise.resolve([]), port80 }), { port80 })
})
