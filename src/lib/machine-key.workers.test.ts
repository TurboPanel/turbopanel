import { describe, expect, it } from 'vitest'
import {
  TURBOPANEL_MACHINE_ID_NAMESPACE,
  deriveMachineKey,
  normalizeMachineKey,
} from './machine-key.ts'

const FIXTURE_MACHINE_ID = '0123456789abcdef0123456789abcdef'
const PINNED_MACHINE_KEY =
  '11716aa801bce01e817f5c72a7170e94dc0df512209c1785012b630648be628b'

describe('machine-key (Workers Web Crypto)', () => {
  it('uses the pinned application-id namespace literal', () => {
    expect(TURBOPANEL_MACHINE_ID_NAMESPACE).toBe(
      '57fd317c-089a-4d52-9d3d-bbf76ba30383',
    )
  })

  it('deriveMachineKey returns undefined for blank input', async () => {
    expect(await deriveMachineKey('')).toBeUndefined()
    expect(await deriveMachineKey('   ')).toBeUndefined()
  })

  it('deriveMachineKey matches the daemon parity vector', async () => {
    expect(await deriveMachineKey(FIXTURE_MACHINE_ID)).toBe(PINNED_MACHINE_KEY)
    expect(await deriveMachineKey(`  ${FIXTURE_MACHINE_ID.toUpperCase()}  `)).toBe(
      PINNED_MACHINE_KEY,
    )
  })

  it('normalizeMachineKey accepts canonical 64-char hex only', () => {
    expect(normalizeMachineKey(`  ${PINNED_MACHINE_KEY.toUpperCase()}  `)).toBe(
      PINNED_MACHINE_KEY,
    )
    expect(normalizeMachineKey(undefined)).toBeUndefined()
    expect(normalizeMachineKey(FIXTURE_MACHINE_ID)).toBeUndefined()
    expect(normalizeMachineKey('g'.repeat(64))).toBeUndefined()
  })
})
