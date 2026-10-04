import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  effectiveServiceResources,
  parseComposeBytes,
  parseComposeCpus,
} from './compose-resource-usage.ts'

describe('parseComposeBytes', () => {
  it('reads bare numbers as bytes and every documented unit with 1024 steps', () => {
    assertEquals(parseComposeBytes(1048576), 1048576)
    assertEquals(parseComposeBytes('100'), 100)
    assertEquals(parseComposeBytes('100b'), 100)
    assertEquals(parseComposeBytes('2k'), 2048)
    assertEquals(parseComposeBytes('2kb'), 2048)
    assertEquals(parseComposeBytes('512m'), 512 * 1024 ** 2)
    assertEquals(parseComposeBytes('512MB'), 512 * 1024 ** 2)
    assertEquals(parseComposeBytes('1g'), 1024 ** 3)
    assertEquals(parseComposeBytes('1.5gb'), 1.5 * 1024 ** 3)
  })

  it('ignores what it cannot read rather than guessing', () => {
    assertEquals(parseComposeBytes('{$MEM}'), undefined)
    assertEquals(parseComposeBytes('lots'), undefined)
    assertEquals(parseComposeBytes('5x'), undefined)
    assertEquals(parseComposeBytes(0), undefined)
    assertEquals(parseComposeBytes(undefined), undefined)
  })
})

describe('parseComposeCpus', () => {
  it('reads numbers and numeric strings, ignores the rest', () => {
    assertEquals(parseComposeCpus(1.5), 1.5)
    assertEquals(parseComposeCpus('0.5'), 0.5)
    assertEquals(parseComposeCpus('{$CPUS}'), undefined)
    assertEquals(parseComposeCpus(0), undefined)
  })
})

describe('effectiveServiceResources', () => {
  it('counts nothing for a service that asks for nothing', () => {
    const out = effectiveServiceResources({ web: { image: 'x' } }, new Map())
    assertEquals(out.get('web'), {})
  })

  it('takes the larger of cpus and deploy limits, and settings win over the document', () => {
    const services = {
      a: { cpus: 1, deploy: { resources: { limits: { cpus: '2', memory: '1g' } } } },
      b: { cpus: 4, mem_limit: '1g' },
    }
    const out = effectiveServiceResources(services, new Map([['b', { cpus: 1, memoryBytes: 10 }]]))
    assertEquals(out.get('a'), { cpus: 2, memoryBytes: 1024 ** 3 })
    assertEquals(out.get('b'), { cpus: 1, memoryBytes: 10 })
  })

  it('counts a reservation only when it is larger than the limit', () => {
    const out = effectiveServiceResources(
      {
        a: { mem_limit: '1g', mem_reservation: '2g' },
        b: { cpus: 2, deploy: { resources: { reservations: { cpus: '1', memory: '4m' } } } },
      },
      new Map()
    )
    assertEquals(out.get('a'), { memoryBytes: 2 * 1024 ** 3 })
    assertEquals(out.get('b'), { cpus: 2, memoryBytes: 4 * 1024 ** 2 })
  })

  it('multiplies by deploy.replicas and keeps settings-only services', () => {
    const out = effectiveServiceResources(
      { a: { cpus: 1, deploy: { replicas: 3 } } },
      new Map([['gone', { cpus: 2 }]])
    )
    assertEquals(out.get('a'), { cpus: 3 })
    assertEquals(out.get('gone'), { cpus: 2 })
  })
})
