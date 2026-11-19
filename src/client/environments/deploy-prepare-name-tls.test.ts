/**
 * What a deploy prepares for a hosting whose names carry different certificates
 * (database; skips without TURBOPANEL_DATABASE_URL): the refusal for a daemon
 * without `hosting-name-tls-v1`, the mixed `nameTls` payload, the unchanged
 * payload when every name agrees, and the www redirect names.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { doorway, hostname, hosting, server, tls } from '../../db/schema.ts'
import { replaceHostingHostnames } from '../../features/servers/hostname-records.ts'
import { nameTlsPinIds } from '../../features/hostings/name-tls-wire.ts'
import { withScenario } from '../../features/tunnels/nudge-scenario.test.support.ts'
import { HOSTING_NAME_TLS_FEATURE } from '../../lib/version-wire.ts'
import { type OrgTlsCandidate, resolveHttpHostingEntry } from './deploy-prepare.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const NAMES = ['a.example.net', 'b.example.net', 'c.example.net']
const ALL_NAMES = [...NAMES, 'www.a.example.net', 'www.b.example.net', 'www.c.example.net']

type S = Parameters<Parameters<typeof withScenario>[1]>[0]

async function libraryRow(s: S): Promise<OrgTlsCandidate> {
  const [row] = await s.db
    .insert(tls)
    .values({ organizationId: s.organizationId, source: 'upload', status: 'ready', name: 'pair' })
    .returning({ id: tls.id })
  return {
    id: row!.id,
    source: 'upload',
    options: null,
    certificatePem: 'CERTIFICATE',
    privateKeyPem: 'KEY',
    metadata: {
      dnsNames: ALL_NAMES,
      hasWildcard: false,
      notBefore: '2020-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      fingerprintSha256: `fp-${row!.id}`,
      subject: 'CN=a.example.net',
      issuer: 'CN=test',
      status: 'ready',
    },
  }
}

async function prepare(s: S, candidates: OrgTlsCandidate[]) {
  const [h] = await s.db.select().from(hosting).where(eq(hosting.id, s.hostingAId))
  return await resolveHttpHostingEntry(
    s.db,
    { id: h!.id, options: h!.options, tlsId: h!.tlsId, ipId: h!.ipId },
    { id: 'svc', composeServiceName: 'web' },
    candidates,
    s.siteAId,
    false,
    s.organizationId
  )
}

async function setup(s: S, www: 'off' | 'both' | 'www-to-root', picks: Array<0 | 1 | 'self'>) {
  await s.db.delete(doorway).where(eq(doorway.hostingId, s.hostingAId))
  const pairs = [await libraryRow(s), await libraryRow(s)]
  await s.db
    .update(hosting)
    .set({ options: { hostnames: NAMES, ...(www === 'off' ? {} : { www }) } })
    .where(eq(hosting.id, s.hostingAId))
  const choices = new Map(
    NAMES.map((name, i) => {
      const pick = picks[i]!
      return [
        name,
        pick === 'self'
          ? { certificate: 'self_signed' as const, tlsId: null }
          : { certificate: 'library' as const, tlsId: pairs[pick]!.id },
      ]
    })
  )
  await replaceHostingHostnames(s.db, s.hostingAId, s.organizationId, NAMES, choices)
  return pairs
}

async function cleanup(s: S, pairs: OrgTlsCandidate[]) {
  await s.db.delete(hostname).where(eq(hostname.hostingId, s.hostingAId))
  for (const pair of pairs) await s.db.delete(tls).where(eq(tls.id, pair.id))
}

async function giveFeature(s: S) {
  await s.db
    .update(server)
    .set({ daemon: { projection: { features: [HOSTING_NAME_TLS_FEATURE] } } })
    .where(eq(server.id, s.siteAId))
}

test('mixed names on a daemon without the feature are refused with 409', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'off', [0, 0, 'self'])
    try {
      const result = await prepare(s, pairs)
      if (!('error' in result)) throw new TypeError('expected a refusal')
      assertEquals(result.error.status, 409)
      const body = (await result.error.json()) as { error: string; hostingId: string }
      assertEquals([body.error, body.hostingId], ['name_certificates_need_update', s.hostingAId])
    } finally {
      await cleanup(s, pairs)
    }
  })
})

test('mixed names on a daemon with the feature send the common pin and one entry', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'off', [0, 0, 'self'])
    try {
      await giveFeature(s)
      const result = await prepare(s, pairs)
      if (!('entry' in result)) throw new TypeError('expected an entry')
      assertEquals(result.entry.tlsId, pairs[0]!.id)
      assertEquals(result.entry.nameTls, [{ hostname: 'c.example.net', tlsMode: 'internal' }])
      assertEquals(JSON.stringify(result.entry).includes('challenge'), false)
    } finally {
      await cleanup(s, pairs)
    }
  })
})

test('a per-name pin is an entry and counts as material the deploy must carry', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'off', [0, 0, 1])
    try {
      await giveFeature(s)
      const result = await prepare(s, pairs)
      if (!('entry' in result)) throw new TypeError('expected an entry')
      assertEquals(result.entry.nameTls, [{ hostname: 'c.example.net', tlsId: pairs[1]!.id }])
      assertEquals(nameTlsPinIds(result.entry.nameTls), [pairs[1]!.id])
    } finally {
      await cleanup(s, pairs)
    }
  })
})

test('names that agree send today payload with no nameTls, with or without the feature', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'off', [0, 0, 0])
    try {
      for (const withFeature of [false, true]) {
        if (withFeature) await giveFeature(s)
        const result = await prepare(s, pairs)
        if (!('entry' in result)) throw new TypeError('expected an entry')
        assertEquals(result.entry.tlsId, pairs[0]!.id)
        assertEquals('nameTls' in result.entry, false)
      }
    } finally {
      await cleanup(s, pairs)
    }
  })
})

test('with www both, a www name with its own choice gets its own entry', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'both', [0, 0, 0])
    try {
      await giveFeature(s)
      await s.db
        .update(hostname)
        .set({ certificate: 'self_signed', tlsId: null })
        .where(eq(hostname.hostname, 'www.b.example.net'))
      const result = await prepare(s, pairs)
      if (!('entry' in result)) throw new TypeError('expected an entry')
      assertEquals(result.entry.nameTls, [{ hostname: 'www.b.example.net', tlsMode: 'internal' }])
    } finally {
      await cleanup(s, pairs)
    }
  })
})

test('with www-to-root, a redirect-only www name keeps its own choice', async () => {
  await withScenario({}, async (s) => {
    const pairs = await setup(s, 'www-to-root', [0, 0, 0])
    try {
      await giveFeature(s)
      await s.db
        .update(hostname)
        .set({ certificate: 'self_signed', tlsId: null })
        .where(eq(hostname.hostname, 'www.c.example.net'))
      const result = await prepare(s, pairs)
      if (!('entry' in result)) throw new TypeError('expected an entry')
      assertEquals(result.entry.nameTls, [{ hostname: 'www.c.example.net', tlsMode: 'internal' }])
    } finally {
      await cleanup(s, pairs)
    }
  })
})
