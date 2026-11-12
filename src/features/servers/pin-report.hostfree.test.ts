import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { pinPasskeysSigningInput, pinReportSigningInput } from '../../daemon/authn/pin-report.ts'
import { intakeHelloPinReport } from '../../daemon/pin-report-intake.ts'
import { describeEvent, NOTIFICATION_EVENT_DEFINITIONS } from '../notifications/events.ts'
import { pinPasskeysMatch, recordPinReport, type VerifiedPinReport } from './pin-report.ts'

const test = Deno.test.bind(Deno)

const FP_A = 'a'.repeat(43)
const FP_B = 'b'.repeat(43)
const NOW = new Date('2026-11-05T12:00:00.000Z')

type Row = {
  organizationId: string | null
  name: string | null
  hostname?: string | null
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
  const [{ trustLevel, ...written } = {}] = writes
  assertEquals(trustLevel !== undefined, true, 'a report naming a key holds the server at level 2')
  assertEquals(
    [written],
    [
      {
        trustPinFingerprint: FP_A,
        trustPinKeyset: 2,
        trustPinReportedAt: NOW,
        isTrustPinMatching: true,
        trustSilenceStage: null,
        trustSilenceSince: null,
        trustSilenceAliveAt: null,
      },
    ]
  )
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
  // An empty pin proves no pin: the level is left alone.
  assertEquals(writes[0] !== undefined && 'trustLevel' in writes[0], false)
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

test('the notice names a server that has only a hostname', async () => {
  const title = NOTIFICATION_EVENT_DEFINITIONS['panel.pin_mismatch'].title
  const cases: [string | null, string | null, string][] = [
    [null, 'manvm', 'Server manvm reported a different control plane key'],
    ['  ', 'manvm.lan', 'Server manvm.lan reported a different control plane key'],
    ['kappa', 'manvm', 'Server kappa reported a different control plane key'],
    [null, null, 'Server unknown reported a different control plane key'],
  ]
  for (const [name, hostname, expected] of cases) {
    const { db } = fakeDb({
      organizationId: 'o1',
      name,
      hostname,
      fingerprint: null,
      matching: null,
    })
    const r = recorder()
    await recordPinReport(db, undefined, 's1', report(FP_B), { current: FP_A }, r.deps)
    const sent = r.emits[0] as { context: Parameters<typeof title>[0] }
    assertEquals(title(sent.context), expected)
  }
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

const HASH_OLD = 'o'.repeat(43)
const HASH_NOW = 'n'.repeat(43)

test('rotation passkeys: behind, unknown and unreported are not a mismatch', () => {
  const at = (keyset: number, passkeys?: string): VerifiedPinReport => ({
    pinnedBy: 'install',
    current: FP_A,
    keyset,
    ...(passkeys === undefined ? {} : { passkeys }),
  })
  const kids = { current: FP_A, passkeys: HASH_NOW, keyset: 3 }
  // An older daemon, and a server that has not learned the passkeys yet.
  assertEquals(pinPasskeysMatch(at(3), kids), true)
  assertEquals(pinPasskeysMatch(at(3, ''), kids), true)
  // Behind: it holds an earlier key set and catches up on its daily read.
  assertEquals(pinPasskeysMatch(at(2, HASH_OLD), kids), true)
  // At the live key set with another set: a real mismatch.
  assertEquals(pinPasskeysMatch(at(3, HASH_OLD), kids), false)
  assertEquals(pinPasskeysMatch(at(3, HASH_NOW), kids), true)
  // The marked set could not be read: unknown is never a mismatch.
  assertEquals(pinPasskeysMatch(at(3, HASH_OLD), { current: FP_A, keyset: 3 }), true)
  // None marked here, yet the server pinned some: a mismatch.
  assertEquals(
    pinPasskeysMatch(at(3, HASH_OLD), { current: FP_A, passkeys: null, keyset: 3 }),
    false
  )
})

test('a passkeys mismatch says both sides, in the audit row and in the mail', async () => {
  const { db, writes } = fakeDb({
    organizationId: 'o1',
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  const r = recorder()
  const pinned = { ...report(FP_A), keyset: 3, passkeys: HASH_OLD }
  const kids = { current: FP_A, passkeys: HASH_NOW, keyset: 3 }
  assertEquals(await recordPinReport(db, undefined, 's1', pinned, kids, r.deps), true)
  assertEquals(writes[0]?.isTrustPinMatching, false)
  const audit = r.audits[0] as { context: Record<string, unknown> }
  assertEquals(audit.context, {
    reported: FP_A,
    expected: FP_A,
    keyset: 3,
    expectedKeyset: 3,
    reportedPasskeys: HASH_OLD,
    expectedPasskeys: HASH_NOW,
  })
  const emitted = r.emits[0] as { context: Record<string, string> }
  assertEquals(emitted.context, {
    serverName: 'kappa',
    reported: FP_A,
    expected: FP_A,
    reportedPasskeys: HASH_OLD,
    expectedPasskeys: HASH_NOW,
  })
  const mail = describeEvent('panel.pin_mismatch', emitted.context)
  assertEquals(mail.title, 'Server kappa reported different rotation passkeys')
  const body = mail.body ?? ''
  assert(body.includes(HASH_OLD) && body.includes(HASH_NOW), body)
  // The wrong-key mail still names the two keys.
  const otherKey = describeEvent('panel.pin_mismatch', {
    serverName: 'kappa',
    reported: FP_B,
    expected: FP_A,
  })
  assertEquals(otherKey.title, 'Server kappa reported a different control plane key')
  const otherBody = otherKey.body ?? ''
  assert(otherBody.includes(FP_B) && otherBody.includes(FP_A), otherBody)

  // The same server one key set behind: recorded as matching, nothing raised.
  const behind = fakeDb({ organizationId: 'o1', name: 'kappa', fingerprint: null, matching: null })
  const quiet = recorder()
  assertEquals(
    await recordPinReport(behind.db, undefined, 's1', { ...pinned, keyset: 2 }, kids, quiet.deps),
    false
  )
  assertEquals(behind.writes[0]?.isTrustPinMatching, true)
  assertEquals(behind.writes[0]?.trustPinPasskeys, HASH_OLD)
  assertEquals([quiet.audits.length, quiet.emits.length], [0, 0])
})

test('the hello intake: a failed read of the marked passkeys does not flag the server', async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const iat = Math.floor(Date.now() / 1000)
  const ctx = { sessionId: 'sess-1', serverId: 's1', keyId: 'key-1' }
  const fields = { pinnedBy: 'install', current: FP_A, keyset: 2, iat }
  const sign = async (input: string) =>
    base64urlEncode(
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(input))
      )
    )
  const sig = await sign(pinReportSigningInput({ ...ctx, ...fields }))
  const passkeysSig = await sign(pinPasskeysSigningInput({ ...ctx, passkeys: HASH_OLD, iat }))
  // This double has no `orderBy`, so the marked passkeys read throws.
  const { db, writes } = fakeDb({
    organizationId: 'o1',
    name: 'kappa',
    fingerprint: null,
    matching: null,
  })
  await intakeHelloPinReport(
    { ...fields, sig, passkeys: HASH_OLD, passkeysSig },
    {
      ...ctx,
      publicJwk,
      secrets: undefined,
      identity: () =>
        Promise.resolve({
          current: { kid: FP_A },
          next: null,
          keyset: 2,
        } as unknown as PanelIdentity),
      withDb: (fn: (db: Db) => Promise<boolean>) => fn(db),
    }
  )
  assertEquals(writes[0]?.trustPinPasskeys, HASH_OLD)
  assertEquals(writes[0]?.isTrustPinMatching, true)
})
