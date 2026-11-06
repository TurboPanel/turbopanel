import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { pinReportSigningInput } from '../../daemon/authn/pin-report.ts'
import { intakeHelloPinReport } from '../../daemon/pin-report-intake.ts'
import { recordPinReport, type VerifiedPinReport } from './pin-report.ts'

const test = Deno.test.bind(Deno)

const FP_A = 'a'.repeat(43)
const FP_B = 'b'.repeat(43)
const NOW = new Date('2026-11-05T12:00:00.000Z')

type Row = {
  organizationId: string | null
  name: string | null
  fingerprint: string | null
  matching: boolean | null
}

/** Just the select-then-update chain recordPinReport uses, with the writes kept. */
function fakeDb(row: Row | undefined, opts: { failSelect?: boolean } = {}) {
  const writes: Record<string, unknown>[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            opts.failSelect ? Promise.reject(new Error('down')) : Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          writes.push(values)
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
  return { db, writes }
}

function recorder() {
  const audits: unknown[] = []
  const emits: unknown[] = []
  return {
    audits,
    emits,
    deps: {
      now: () => NOW,
      audit: (_db: unknown, entry: unknown) => {
        audits.push(entry)
        return Promise.resolve()
      },
      emit: (_db: unknown, _secrets: unknown, input: unknown) => {
        emits.push(input)
        return Promise.resolve({ inbox: 0, deliveries: 0, sent: 0, failed: 0, held: 0 })
      },
    },
  }
}

const report = (current: string, pinnedBy: VerifiedPinReport['pinnedBy'] = 'install') => ({
  pinnedBy,
  current,
  keyset: 2,
})

test('a matching report is stored and raises nothing', async () => {
  const { db, writes } = fakeDb({
    organizationId: 'o1',
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  const r = recorder()
  assertEquals(
    await recordPinReport(db, undefined, 's1', report(FP_A), { current: FP_A }, r.deps),
    false
  )
  assertEquals(writes, [
    {
      trustPinFingerprint: FP_A,
      trustPinKeyset: 2,
      trustPinReportedAt: NOW,
      isTrustPinMatching: true,
      trustSilenceStage: null,
      trustSilenceSince: null,
      trustSilenceAliveAt: null,
    },
  ])
  assertEquals([r.audits.length, r.emits.length], [0, 0])
})

test('a report naming the next key matches too', async () => {
  const { db, writes } = fakeDb({
    organizationId: 'o1',
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  const r = recorder()
  await recordPinReport(db, undefined, 's1', report(FP_B), { current: FP_A, next: FP_B }, r.deps)
  assertEquals(writes[0]?.isTrustPinMatching, true)
})

test('an unsafe pin counts as matching (it has its own badge)', async () => {
  const { db, writes } = fakeDb({
    organizationId: 'o1',
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  const r = recorder()
  assertEquals(
    await recordPinReport(db, undefined, 's1', report('', 'unsafe'), { current: FP_A }, r.deps),
    false
  )
  assertEquals(writes[0]?.isTrustPinMatching, true)
  assertEquals(r.emits.length, 0)
})

test('another key raises one audit row and one notification, once per fingerprint', async () => {
  const first = fakeDb({ organizationId: 'o1', name: 'kappa', fingerprint: null, matching: null })
  const r = recorder()
  assertEquals(
    await recordPinReport(first.db, undefined, 's1', report(FP_B), { current: FP_A }, r.deps),
    true
  )
  assertEquals(first.writes[0]?.isTrustPinMatching, false)
  assertEquals(r.audits, [
    {
      organizationId: 'o1',
      actorUserId: null,
      action: 'server.panel_pin.mismatch',
      targetType: 'server',
      targetId: 's1',
      context: { reported: FP_B, expected: FP_A, keyset: 2 },
    },
  ])
  assertEquals(r.emits, [
    {
      event: 'panel.pin_mismatch',
      organizationId: 'o1',
      context: { serverName: 'kappa', reported: FP_B, expected: FP_A },
      targetType: 'server',
      targetId: 's1',
    },
  ])
  // The same mismatch again: stored, not raised again.
  const again = fakeDb({ organizationId: 'o1', name: 'kappa', fingerprint: FP_B, matching: false })
  assertEquals(
    await recordPinReport(again.db, undefined, 's1', report(FP_B), { current: FP_A }, r.deps),
    false
  )
  assertEquals(again.writes.length, 1)
  assertEquals([r.audits.length, r.emits.length], [1, 1])
})

test('a server with no organization is audited but not notified', async () => {
  const { db } = fakeDb({ organizationId: null, name: 'lambda', fingerprint: null, matching: null })
  const r = recorder()
  assertEquals(
    await recordPinReport(db, undefined, 's1', report(FP_B), { current: FP_A }, r.deps),
    true
  )
  assertEquals([r.audits.length, r.emits.length], [1, 0])
})

test('an unknown server or a database failure records nothing and never throws', async () => {
  const r = recorder()
  const missing = fakeDb(undefined)
  assertEquals(
    await recordPinReport(missing.db, undefined, 's1', report(FP_A), { current: FP_A }, r.deps),
    false
  )
  assertEquals(missing.writes.length, 0)
  const down = fakeDb(undefined, { failSelect: true })
  assertEquals(
    await recordPinReport(down.db, undefined, 's1', report(FP_A), { current: FP_A }, r.deps),
    false
  )
})

test('the hello intake verifies the report, then reads the identity and records it', async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const iat = Math.floor(Date.now() / 1000)
  const fields = { pinnedBy: 'install', current: FP_B, keyset: 1, iat }
  const ctx = { sessionId: 'sess-1', serverId: 's1', keyId: 'key-1' }
  const sig = base64urlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new TextEncoder().encode(pinReportSigningInput({ ...ctx, ...fields }))
      )
    )
  )
  const { db, writes } = fakeDb({
    organizationId: null,
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  const identity = { current: { kid: FP_A }, next: null } as unknown as PanelIdentity
  let identityReads = 0
  const base = {
    ...ctx,
    publicJwk,
    secrets: undefined,
    identity: () => {
      identityReads += 1
      return Promise.resolve(identity)
    },
    withDb: (fn: (db: Db) => Promise<boolean>) => fn(db),
  }
  // Unsigned: ignored before the identity is even read.
  await intakeHelloPinReport({ ...fields }, base)
  assertEquals([identityReads, writes.length], [0, 0])
  await intakeHelloPinReport({ ...fields, sig }, base)
  assertEquals(identityReads, 1)
  assertEquals(writes[0]?.trustPinFingerprint, FP_B)
  assertEquals(writes[0]?.isTrustPinMatching, false)
  // No identity loaded: nothing to compare with, nothing written.
  await intakeHelloPinReport({ ...fields, sig }, { ...base, identity: () => Promise.resolve(null) })
  assertEquals(writes.length, 1)
})
