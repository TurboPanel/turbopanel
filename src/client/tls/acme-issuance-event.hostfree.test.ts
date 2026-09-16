/**
 * Host-free coverage for daemon-observed ACME issuance events (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { handleAcmeIssuanceEvent } from './acme-issuance-event.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Row = {
  id: string
  status: string
  metadata: unknown
}

function fakeDb(
  rows: Row[],
): { db: Db; updates: Array<{ id: string; patch: Record<string, unknown> }> } {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const lastUpdateTarget = rows.find((r) => r.status === 'managed')?.id
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // The handler only ever updates the single row it just matched —
          // stand in for `eq(tls.id, row.id)` without re-implementing drizzle.
          const target = lastUpdateTarget ?? rows[0]?.id ?? ''
          updates.push({ id: target, patch })
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
  return { db, updates }
}

test('handleAcmeIssuanceEvent is a no-op when no row covers the hostname', async () => {
  const { db, updates } = fakeDb([])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, false)
  assertEquals(updates.length, 0)
})

test('handleAcmeIssuanceEvent skips a non-managed lets_encrypt row', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'pending',
      metadata: { dnsNames: ['app.example.com'], hasWildcard: false, notBefore: '', subject: '', issuer: '' },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, false)
  assertEquals(updates.length, 0)
})

test('handleAcmeIssuanceEvent skips a managed row whose dnsNames do not cover the hostname', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: { dnsNames: ['other.example.com'], hasWildcard: false, notBefore: '', subject: '', issuer: '' },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, false)
  assertEquals(updates.length, 0)
})

test('handleAcmeIssuanceEvent writes lastError onto the matching managed row, leaving status untouched', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: {
        dnsNames: ['app.example.com'],
        hasWildcard: false,
        notBefore: '',
        subject: '',
        issuer: '',
        acme: { challengeType: 'http-01', managedBy: 'caddy' },
      },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: false,
    errorMessage: 'received fatal alert: InternalError',
  })
  assertEquals(result.updated, true)
  assertEquals(updates.length, 1)
  const patch = updates[0]!.patch
  // The regression this guards: a visibility feature must never write
  // `status` — that column, not this jsonb field, is what
  // isReadyCandidate()/resolveTlsForHosting() gate deploys on.
  assertEquals('status' in patch, false)
  const metadata = patch.metadata as { acme?: { lastError?: string; managedBy?: string; challengeType?: string } }
  assertEquals(metadata.acme?.lastError, 'received fatal alert: InternalError')
  // Sibling acme fields survive the merge-patch untouched.
  assertEquals(metadata.acme?.managedBy, 'caddy')
  assertEquals(metadata.acme?.challengeType, 'http-01')
})

test('handleAcmeIssuanceEvent falls back to a default message when the daemon sent none', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: { dnsNames: ['app.example.com'], hasWildcard: false, notBefore: '', subject: '', issuer: '' },
    },
  ])
  await handleAcmeIssuanceEvent(db, { hostname: 'app.example.com', ok: false })
  const metadata = updates[0]!.patch.metadata as { acme?: { lastError?: string } }
  assertEquals(metadata.acme?.lastError, 'ACME issuance failed')
})

test('handleAcmeIssuanceEvent clears lastError on recovery, keeping other acme fields', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: {
        dnsNames: ['app.example.com'],
        hasWildcard: false,
        notBefore: '',
        subject: '',
        issuer: '',
        acme: { lastError: 'stale failure', managedBy: 'caddy' },
      },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: true,
  })
  assertEquals(result.updated, true)
  const metadata = updates[0]!.patch.metadata as { acme?: { lastError?: string; managedBy?: string } }
  assertEquals('lastError' in (metadata.acme ?? {}), false)
  assertEquals(metadata.acme?.managedBy, 'caddy')
})

test('handleAcmeIssuanceEvent matches a wildcard dnsNames entry', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: { dnsNames: ['*.example.com'], hasWildcard: true, notBefore: '', subject: '', issuer: '' },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'app.example.com',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, true)
  assertEquals(updates.length, 1)
})

test('handleAcmeIssuanceEvent normalizes hostname casing and trailing dot before matching', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: { dnsNames: ['app.example.com'], hasWildcard: false, notBefore: '', subject: '', issuer: '' },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: 'APP.example.com.',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, true)
  assertEquals(updates.length, 1)
})

test('handleAcmeIssuanceEvent is a no-op for an empty hostname', async () => {
  const { db, updates } = fakeDb([
    {
      id: 'tls-1',
      status: 'managed',
      metadata: { dnsNames: ['app.example.com'], hasWildcard: false, notBefore: '', subject: '', issuer: '' },
    },
  ])
  const result = await handleAcmeIssuanceEvent(db, {
    hostname: '   ',
    ok: false,
    errorMessage: 'boom',
  })
  assertEquals(result.updated, false)
  assertEquals(updates.length, 0)
})
