/**
 * Real-Postgres coverage for storing the certificate and key a serving host
 * issued (`storeIssuedCertificate`, behind `POST /api/daemon/v1/tls/issued`).
 * Keys and certificates here are minted for the test; nothing is read from a
 * real host.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  audit,
  environment,
  hosting,
  organization,
  project,
  server,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import type { Db } from '../../db/connection.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { issueLeafCertificate, mintOrganizationCa } from '../../lib/tls/self-signed.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { REFUSAL_MESSAGE, replaces, storeIssuedCertificate } from './issued-certificate.ts'
import { handleIssueEvent } from '../../features/tls/http-issuance/events.ts'
import {
  type HttpIssuanceState,
  newHttpIssuanceState,
  readHttpIssuanceState,
  withHttpIssuanceState,
} from '../../features/tls/http-issuance/state.ts'
import {
  type CaddyKeyKind,
  makeCaddyPair,
} from '../../test-fixtures/caddy-key-fixtures.test.support.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HOST = 'shop.example.com'

/** One pool for the file: a pool per fixture runs the server out of clients. */
let sharedDb: Db | undefined

type Fixture = {
  db: Db
  organizationId: string
  serverId: string
  otherServerId: string
  tlsId: string
  deps: Awaited<ReturnType<typeof makeDeps>>
  cleanup: () => Promise<void>
}

async function makeDeps() {
  const config = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  return {
    dataEncryptionSecrets: await deriveEncryptionSecretsConfig(config, 'data-encryption'),
  }
}

async function issuedPair(names: string[], validDays = 90) {
  const ca = await mintOrganizationCa({ organizationId: crypto.randomUUID() })
  return await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, names, { validDays })
}

async function setup(
  options: {
    acmeEnabled?: boolean
    pinnedOnOtherServer?: boolean
    rowNames?: string[]
  } = {}
): Promise<Fixture> {
  sharedDb ??= createDenoDb()
  const db = sharedDb
  const deps = await makeDeps()
  const now = new Date().toISOString()
  const [org] = await db
    .insert(organization)
    .values({
      name: 'Issued Org',
      options: { acmeEnabled: options.acmeEnabled ?? true },
    })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'edge-a' })
    .returning({ id: server.id })
  const [other] = await db
    .insert(server)
    .values({ organizationId, name: 'edge-b' })
    .returning({ id: server.id })
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      organizationId,
      name: 'P',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({
      projectId: proj!.id,
      name: 'e',
      serverId: options.pinnedOnOtherServer ? other!.id : srv!.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const [row] = await db
    .insert(tls)
    .values({
      organizationId,
      name: 'Lets Encrypt for shop',
      source: 'lets_encrypt',
      status: 'automatic',
      metadata: {
        dnsNames: options.rowNames ?? [HOST],
        hasWildcard: false,
        notBefore: '',
        subject: '',
        issuer: '',
        acme: { managedBy: 'caddy' },
      },
      options: { autoRenew: true },
    })
    .returning({ id: tls.id })
  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      tlsId: row!.id,
      options: { hostnames: [HOST] },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })
  return {
    db,
    organizationId,
    serverId: srv!.id,
    otherServerId: other!.id,
    tlsId: row!.id,
    deps,
    async cleanup() {
      await db.delete(audit).where(eq(audit.organizationId, organizationId))
      await db.delete(hosting).where(eq(hosting.id, host!.id))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      await db.delete(service).where(eq(service.id, svc!.id))
      await db.delete(environment).where(eq(environment.id, env!.id))
      await db.delete(project).where(eq(project.id, proj!.id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

async function readRow(f: Fixture) {
  const [row] = await f.db.select().from(tls).where(eq(tls.id, f.tlsId))
  return row!
}

test('stores the chain sealed, with real expiry, issuer and fingerprint, and never touches status', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const pair = await issuedPair([HOST])
    const result = await storeIssuedCertificate(
      f.db,
      {
        serverId: f.serverId,
        hostname: HOST,
        certificatePem: pair.certificatePem,
        privateKeyPem: pair.privateKeyPem,
      },
      f.deps
    )
    assertEquals(result, { ok: true, stored: true, tlsIds: [f.tlsId] })
    const row = await readRow(f)
    assertEquals(row.status, 'automatic')
    assertEquals(row.certificatePem, pair.certificatePem)
    assertEquals(row.privateKeyPem?.startsWith('tpsecret.'), true)
    assertEquals(row.privateKeyPem?.includes('BEGIN'), false)
    assertEquals(
      await decryptSecret(f.deps.dataEncryptionSecrets, row.privateKeyPem!),
      pair.privateKeyPem
    )
    assertEquals(row.fingerprintSha256, pair.parsed.fingerprintSha256)
    assertEquals(new Date(row.notAfter!).getTime(), pair.parsed.notAfter.getTime())
    const metadata = row.metadata as {
      dnsNames: string[]
      issuer: string
      subject: string
      notBefore: string
      acme: {
        storedNames: string[]
        issuedByServerId: string
        notAfter: string
      }
    }
    assertEquals(metadata.dnsNames, [HOST])
    assertEquals(metadata.issuer, pair.parsed.issuer)
    assertEquals(metadata.subject, pair.parsed.subject)
    assertEquals(metadata.acme.storedNames, [HOST])
    assertEquals(metadata.acme.issuedByServerId, f.serverId)
    const trail = await f.db.select().from(audit).where(eq(audit.organizationId, f.organizationId))
    assertEquals(trail.length, 1)
    assertEquals(trail[0]!.action, 'tls.certificate.store')
    assertEquals(JSON.stringify(trail[0]).includes('PRIVATE'), false)
    assertEquals(JSON.stringify(trail[0]).includes('tpsecret'), false)
  } finally {
    await f.cleanup()
  }
})

test('the same pair again changes nothing; a renewal replaces the pair', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const first = await issuedPair([HOST])
    const send = (pair: { certificatePem: string; privateKeyPem: string }) =>
      storeIssuedCertificate(
        f.db,
        {
          serverId: f.serverId,
          hostname: HOST,
          certificatePem: pair.certificatePem,
          privateKeyPem: pair.privateKeyPem,
        },
        f.deps
      )
    assertEquals((await send(first)).ok && (await send(first)), {
      ok: true,
      stored: false,
      tlsIds: [],
    })
    const renewed = await issuedPair([HOST], 120)
    assertEquals(await send(renewed), {
      ok: true,
      stored: true,
      tlsIds: [f.tlsId],
    })
    const row = await readRow(f)
    assertEquals(row.fingerprintSha256, renewed.parsed.fingerprintSha256)
    assertEquals(
      await decryptSecret(f.deps.dataEncryptionSecrets, row.privateKeyPem!),
      renewed.privateKeyPem
    )
  } finally {
    await f.cleanup()
  }
})

test('refuses a key that does not match, a certificate for another name, an expired one and a self-signed one', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const good = await issuedPair([HOST])
    const other = await issuedPair([HOST])
    const wrongName = await issuedPair(['elsewhere.example.com'])
    const send = (certificatePem: string, privateKeyPem: string, now?: () => Date) =>
      storeIssuedCertificate(
        f.db,
        { serverId: f.serverId, hostname: HOST, certificatePem, privateKeyPem },
        { ...f.deps, ...(now ? { now } : {}) }
      )
    assertEquals(await send(good.certificatePem, other.privateKeyPem), {
      ok: false,
      error: 'key_mismatch',
      message: REFUSAL_MESSAGE.key_mismatch,
      status: 400,
    })
    assertEquals(await send(wrongName.certificatePem, wrongName.privateKeyPem), {
      ok: false,
      error: 'certificate_not_for_hostname',
      message: REFUSAL_MESSAGE.certificate_not_for_hostname,
      status: 400,
    })
    const farFuture = () => new Date(Date.now() + 400 * 86_400_000)
    assertEquals(await send(good.certificatePem, good.privateKeyPem, farFuture), {
      ok: false,
      error: 'certificate_expired',
      message: REFUSAL_MESSAGE.certificate_expired,
      status: 400,
    })
    const ca = await mintOrganizationCa({
      organizationId: crypto.randomUUID(),
    })
    assertEquals(await send(ca.certificatePem, ca.privateKeyPem), {
      ok: false,
      error: 'certificate_not_for_hostname',
      message: REFUSAL_MESSAGE.certificate_not_for_hostname,
      status: 400,
    })
    assertEquals((await readRow(f)).privateKeyPem, null)
  } finally {
    await f.cleanup()
  }
})

test('refuses garbage, an oversized chain and a hostname that is not plain', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const good = await issuedPair([HOST])
    const send = (hostname: string, certificatePem: string, privateKeyPem: string) =>
      storeIssuedCertificate(
        f.db,
        { serverId: f.serverId, hostname, certificatePem, privateKeyPem },
        f.deps
      )
    assertEquals((await send(HOST, 'nope', good.privateKeyPem)).ok, false)
    assertEquals(await send(HOST, good.certificatePem, 'not a key'), {
      ok: false,
      error: 'invalid_private_key',
      message: REFUSAL_MESSAGE.invalid_private_key,
      status: 400,
    })
    const longChain = Array(7).fill(good.certificatePem).join('\n')
    assertEquals(await send(HOST, longChain, good.privateKeyPem), {
      ok: false,
      error: 'invalid_certificate',
      message: REFUSAL_MESSAGE.invalid_certificate,
      status: 400,
    })
    for (const bad of ['*.example.com', '../x', 'a b', '', 'a..b']) {
      assertEquals(await send(bad, good.certificatePem, good.privateKeyPem), {
        ok: false,
        error: 'invalid_hostname',
        message: REFUSAL_MESSAGE.invalid_hostname,
        status: 400,
      })
    }
  } finally {
    await f.cleanup()
  }
})

test('a server may only supply a certificate for a hosting placed on it', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ pinnedOnOtherServer: true })
  try {
    const pair = await issuedPair([HOST])
    const result = await storeIssuedCertificate(
      f.db,
      {
        serverId: f.serverId,
        hostname: HOST,
        certificatePem: pair.certificatePem,
        privateKeyPem: pair.privateKeyPem,
      },
      f.deps
    )
    assertEquals(result, {
      ok: false,
      error: 'no_matching_certificate',
      message: REFUSAL_MESSAGE.no_matching_certificate,
      status: 404,
    })
    assertEquals((await readRow(f)).privateKeyPem, null)
    const placed = await storeIssuedCertificate(
      f.db,
      {
        serverId: f.otherServerId,
        hostname: HOST,
        certificatePem: pair.certificatePem,
        privateKeyPem: pair.privateKeyPem,
      },
      f.deps
    )
    assertEquals(placed.ok, true)
  } finally {
    await f.cleanup()
  }
})

test("refuses while the organization has not allowed Let's Encrypt and for a server outside any organization", async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ acmeEnabled: false })
  try {
    const pair = await issuedPair([HOST])
    const input = {
      hostname: HOST,
      certificatePem: pair.certificatePem,
      privateKeyPem: pair.privateKeyPem,
    }
    assertEquals(await storeIssuedCertificate(f.db, { serverId: f.serverId, ...input }, f.deps), {
      ok: false,
      error: 'acme_disabled',
      message: REFUSAL_MESSAGE.acme_disabled,
      status: 409,
    })
    assertEquals(
      await storeIssuedCertificate(
        f.db,
        {
          serverId: crypto.randomUUID(),
          ...input,
        },
        f.deps
      ),
      {
        ok: false,
        error: 'server_not_in_organization',
        message: REFUSAL_MESSAGE.server_not_in_organization,
        status: 403,
      }
    )
  } finally {
    await f.cleanup()
  }
})

test('a certificate for another name of a multi-name row does not overwrite a still-valid pair', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ rowNames: [HOST, `www.${HOST}`] })
  try {
    const apex = await issuedPair([HOST])
    const www = await issuedPair([`www.${HOST}`])
    const send = (hostname: string, pair: { certificatePem: string; privateKeyPem: string }) =>
      storeIssuedCertificate(
        f.db,
        {
          serverId: f.serverId,
          hostname,
          certificatePem: pair.certificatePem,
          privateKeyPem: pair.privateKeyPem,
        },
        f.deps
      )
    assertEquals((await send(HOST, apex)).ok, true)
    assertEquals(await send(`www.${HOST}`, www), {
      ok: true,
      stored: false,
      tlsIds: [],
    })
    assertEquals((await readRow(f)).fingerprintSha256, apex.parsed.fingerprintSha256)
  } finally {
    await f.cleanup()
  }
})

test('the sealed key is the same kind of envelope as an uploaded key', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const deps = await makeDeps()
  const sealed = await encryptSecret(deps.dataEncryptionSecrets, 'x')
  assertEquals(sealed.startsWith('tpsecret.'), true)
})

test('an older valid pair never replaces a newer one; a later expiry does; the same expiry does not', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const send = (pair: { certificatePem: string; privateKeyPem: string }) =>
      storeIssuedCertificate(
        f.db,
        {
          serverId: f.serverId,
          hostname: HOST,
          certificatePem: pair.certificatePem,
          privateKeyPem: pair.privateKeyPem,
        },
        f.deps
      )
    const middle = await issuedPair([HOST], 60)
    const older = await issuedPair([HOST], 30)
    const newer = await issuedPair([HOST], 90)
    assertEquals((await send(middle)).ok && (await send(middle)), {
      ok: true,
      stored: false,
      tlsIds: [],
    })
    assertEquals(await send(older), { ok: true, stored: false, tlsIds: [] })
    assertEquals((await readRow(f)).fingerprintSha256, middle.parsed.fingerprintSha256)
    assertEquals(await send(newer), { ok: true, stored: true, tlsIds: [f.tlsId] })
    assertEquals((await readRow(f)).fingerprintSha256, newer.parsed.fingerprintSha256)
    assertEquals(await send(middle), { ok: true, stored: false, tlsIds: [] })
    assertEquals((await readRow(f)).fingerprintSha256, newer.parsed.fingerprintSha256)
  } finally {
    await f.cleanup()
  }
})

test('replaces(): equal expiry is rejected, later accepted, earlier rejected', async () => {
  const pair = await issuedPair([HOST], 60)
  const now = new Date()
  const stored = (notAfter: Date) => ({ names: [HOST], notAfter: notAfter.toISOString() })
  const at = pair.parsed.notAfter.getTime()
  assertEquals(replaces(stored(new Date(at)), true, pair.parsed, now), false)
  assertEquals(replaces(stored(new Date(at - 1000)), true, pair.parsed, now), true)
  assertEquals(replaces(stored(new Date(at + 1000)), true, pair.parsed, now), false)
  assertEquals(replaces(stored(new Date(at + 1000)), false, pair.parsed, now), true)
})

for (const kind of [
  'ec-p256',
  'ec-p384',
  'ec-p521',
  'rsa-pkcs1',
  'ec-p256-pkcs8',
] as CaddyKeyKind[]) {
  test(`stores the pair exactly as Caddy writes it (${kind}), sealed as PKCS#8`, async () => {
    if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
    const f = await setup()
    try {
      const pair = await makeCaddyPair(kind, [HOST])
      const result = await storeIssuedCertificate(
        f.db,
        {
          serverId: f.serverId,
          hostname: HOST,
          certificatePem: pair.certificatePem,
          privateKeyPem: pair.privateKeyPem,
        },
        f.deps
      )
      assertEquals(result, { ok: true, stored: true, tlsIds: [f.tlsId] })
      const row = await readRow(f)
      assertEquals(row.certificatePem, pair.certificatePem)
      assertEquals(row.privateKeyPem?.startsWith('tpsecret.'), true)
      const opened = await decryptSecret(f.deps.dataEncryptionSecrets, row.privateKeyPem!)
      // The same form as an uploaded key, whatever form Caddy wrote.
      assertEquals(opened.startsWith('-----BEGIN PRIVATE KEY-----'), true)
      assertEquals(opened.includes('EC PRIVATE KEY') || opened.includes('RSA PRIVATE KEY'), false)
      assertEquals(typeof row.fingerprintSha256, 'string')
      assertEquals(new Date(row.notAfter!).getTime() > Date.now(), true)
    } finally {
      await f.cleanup()
    }
  })
}

test('a refused pair says in plain words which part was rejected and never echoes the key', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const good = await makeCaddyPair('ec-p256', [HOST])
    const other = await makeCaddyPair('ec-p256', [HOST])
    const wrongCurve = await makeCaddyPair('ec-secp256k1', [HOST])
    const send = (certificatePem: string, privateKeyPem: string) =>
      storeIssuedCertificate(
        f.db,
        { serverId: f.serverId, hostname: HOST, certificatePem, privateKeyPem },
        f.deps
      )
    const unreadable = await send(good.certificatePem, 'not a key')
    const mismatch = await send(good.certificatePem, other.privateKeyPem)
    const curve = await send(wrongCurve.certificatePem, wrongCurve.privateKeyPem)
    const badChain = await send('nope', good.privateKeyPem)
    for (const [result, code] of [
      [unreadable, 'invalid_private_key'],
      [mismatch, 'key_mismatch'],
      [curve, 'invalid_private_key'],
      [badChain, 'invalid_certificate'],
    ] as const) {
      if (result.ok) throw new Error('expected a refusal')
      assertEquals(result.error, code)
      assertEquals(result.status, 400)
      assertEquals(result.message.length > 20, true)
      const body = JSON.stringify(result)
      const keyBody = good.privateKeyPem.split('\n')[1]!
      assertEquals(body.includes(keyBody), false)
      assertEquals(body.includes('PRIVATE'), false)
    }
    if (unreadable.ok) throw new Error('expected a refusal')
    assertEquals(unreadable.message.includes('private key'), true)
    if (badChain.ok) throw new Error('expected a refusal')
    assertEquals(badChain.message.includes('certificate'), true)
    assertEquals((await readRow(f)).privateKeyPem, null)
  } finally {
    await f.cleanup()
  }
})

test('a key of another kind or curve than the certificate is a key mismatch, in plain words', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const ec = await makeCaddyPair('ec-p256', [HOST])
    const rsa = await makeCaddyPair('rsa-pkcs1', [HOST])
    const p384 = await makeCaddyPair('ec-p384', [HOST])
    const send = (certificatePem: string, privateKeyPem: string) =>
      storeIssuedCertificate(
        f.db,
        { serverId: f.serverId, hostname: HOST, certificatePem, privateKeyPem },
        f.deps
      )
    for (const result of [
      await send(ec.certificatePem, rsa.privateKeyPem),
      await send(rsa.certificatePem, ec.privateKeyPem),
      await send(ec.certificatePem, p384.privateKeyPem),
    ]) {
      if (result.ok) throw new Error('expected a refusal')
      assertEquals(result.error, 'key_mismatch')
      assertEquals(result.status, 400)
      assertEquals(JSON.stringify(result).includes('PRIVATE'), false)
    }
    assertEquals((await readRow(f)).privateKeyPem, null)
  } finally {
    await f.cleanup()
  }
})

const REQUEST_ID = 'req_open_1'

/** Record an open request on the row, asked of `issuingServerId`. */
async function openRequest(
  f: Fixture,
  issuingServerId: string,
  overrides: {
    endedAt?: string | null
    startByAt?: string
    state?: Partial<HttpIssuanceState>
  } = {}
) {
  const row = await readRow(f)
  await f.db
    .update(tls)
    .set({
      metadata: withHttpIssuanceState(
        row.metadata,
        newHttpIssuanceState({
          issuingServerId,
          requestId: REQUEST_ID,
          startedAt: new Date().toISOString(),
          startByAt: overrides.startByAt ?? new Date(Date.now() + 3_600_000).toISOString(),
          endedAt: overrides.endedAt ?? null,
          attemptTimes: [],
          ...overrides.state,
        })
      ),
    })
    .where(eq(tls.id, f.tlsId))
}

function withRequest(pair: Awaited<ReturnType<typeof issuedPair>>, serverId: string) {
  return {
    serverId,
    hostname: HOST,
    certificatePem: pair.certificatePem,
    privateKeyPem: pair.privateKeyPem,
    requestId: REQUEST_ID,
  }
}

test('a pair for an open request is stored sealed in the existing row, even from a server with no pin', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  // The row is pinned on the other server; the asked server holds no pin.
  const f = await setup({ pinnedOnOtherServer: true })
  try {
    await openRequest(f, f.serverId)
    const pair = await issuedPair([HOST])
    const result = await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps)
    assertEquals(result, { ok: true, stored: true, tlsIds: [f.tlsId] })
    const row = await readRow(f)
    assertEquals(row.id, f.tlsId)
    assertEquals(row.certificatePem, pair.certificatePem)
    assertEquals(row.privateKeyPem?.startsWith('tpsecret.'), true)
    assertEquals(row.privateKeyPem?.includes('BEGIN'), false)
    assertEquals(
      await decryptSecret(f.deps.dataEncryptionSecrets, row.privateKeyPem!),
      pair.privateKeyPem
    )
    // The private request state stays on the row.
    assertEquals(JSON.stringify(row.metadata).includes(REQUEST_ID), true)
  } finally {
    await f.cleanup()
  }
})

test('a pair for an open request is refused from another server, a closed or expired request and an unknown id', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const pair = await issuedPair([HOST])
    const notOpen = {
      ok: false as const,
      error: 'request_not_open' as const,
      message: REFUSAL_MESSAGE.request_not_open,
      status: 404 as const,
    }
    // No request recorded yet.
    assertEquals(await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps), notOpen)
    await openRequest(f, f.serverId)
    // The server that was not asked.
    assertEquals(
      await storeIssuedCertificate(f.db, withRequest(pair, f.otherServerId), f.deps),
      notOpen
    )
    assertEquals(
      await storeIssuedCertificate(
        f.db,
        { ...withRequest(pair, f.serverId), requestId: 'req_other' },
        f.deps
      ),
      notOpen
    )
    // The request was made to the other server: the pin holder cannot use the pin rule instead.
    await openRequest(f, f.otherServerId)
    assertEquals(await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps), notOpen)
    await openRequest(f, f.serverId, { endedAt: new Date().toISOString() })
    assertEquals(await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps), notOpen)
    await openRequest(f, f.serverId, { startByAt: new Date(Date.now() - 1000).toISOString() })
    assertEquals(await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps), notOpen)
    assertEquals((await readRow(f)).privateKeyPem, null)
  } finally {
    await f.cleanup()
  }
})

test('a pair for a different hostname than the request is still refused by the name check', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    await openRequest(f, f.serverId)
    const pair = await issuedPair(['other.example.com'])
    const result = await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps)
    assertEquals(result.ok, false)
    if (!result.ok) assertEquals(result.error, 'certificate_not_for_hostname')
    assertEquals((await readRow(f)).privateKeyPem, null)
  } finally {
    await f.cleanup()
  }
})

test('a pair for an open request notes the capture, and the issued event then closes it', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    await openRequest(f, f.serverId)
    const pair = await issuedPair([HOST])
    await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps)
    const stored = readHttpIssuanceState((await readRow(f)).metadata)
    assertEquals(typeof stored?.capturedAt, 'string')
    assertEquals(stored?.endedAt, null)
  } finally {
    await f.cleanup()
  }
})

test('a pair arriving after the issued event closes the request as issued', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    await openRequest(f, f.serverId, { state: { issuedEventAt: new Date().toISOString() } })
    const pair = await issuedPair([HOST])
    await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps)
    const row = await readRow(f)
    const stored = readHttpIssuanceState(row.metadata)
    assertEquals(stored?.phase, 'issued')
    assertEquals(typeof stored?.endedAt, 'string')
    const acme = (row.metadata as { acme: { stage: string; managedBy: string } }).acme
    assertEquals(acme.stage, 'issued')
    assertEquals(acme.managedBy, 'server')
    // A second send of the same pair is harmless and changes nothing.
    const again = await storeIssuedCertificate(f.db, withRequest(pair, f.serverId), f.deps)
    assertEquals(again.ok, true)
    assertEquals(readHttpIssuanceState((await readRow(f)).metadata)?.endedAt, stored?.endedAt)
  } finally {
    await f.cleanup()
  }
})

const WWW = 'www.shop.example.com'

function pairFor(pair: Awaited<ReturnType<typeof issuedPair>>, serverId: string, hostname: string) {
  return { ...withRequest(pair, serverId), hostname }
}

async function readState(f: Fixture) {
  return readHttpIssuanceState((await readRow(f)).metadata)
}

test('a two-name order closes when both names have a pair, pairs before the issued event', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ rowNames: [HOST, WWW] })
  try {
    await openRequest(f, f.serverId, { state: { phase: 'ordering' } })
    const first = await issuedPair([HOST])
    const second = await issuedPair([WWW])
    assertEquals(
      (await storeIssuedCertificate(f.db, pairFor(first, f.serverId, HOST), f.deps)).ok,
      true
    )
    assertEquals(
      (await storeIssuedCertificate(f.db, pairFor(second, f.serverId, WWW), f.deps)).ok,
      true
    )
    assertEquals((await readState(f))?.endedAt, null)
    await handleIssueEvent(f.db, { serverId: f.serverId, requestId: REQUEST_ID, stage: 'issued' })
    const state = await readState(f)
    assertEquals(state?.phase, 'issued')
    assertEquals(typeof state?.endedAt, 'string')
    assertEquals(state?.coveredNames.sort(), [HOST, WWW].sort())
  } finally {
    await f.cleanup()
  }
})

test('a two-name order stays open after issued until the second name has its pair', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ rowNames: [HOST, WWW] })
  try {
    await openRequest(f, f.serverId, { state: { phase: 'ordering' } })
    const first = await issuedPair([HOST])
    const second = await issuedPair([WWW])
    await storeIssuedCertificate(f.db, pairFor(first, f.serverId, HOST), f.deps)
    await handleIssueEvent(f.db, { serverId: f.serverId, requestId: REQUEST_ID, stage: 'issued' })
    assertEquals((await readState(f))?.endedAt, null)
    const result = await storeIssuedCertificate(f.db, pairFor(second, f.serverId, WWW), f.deps)
    assertEquals(result.ok, true)
    assertEquals((await readState(f))?.phase, 'issued')
  } finally {
    await f.cleanup()
  }
})

test('one certificate for both names: the second name is accepted after the close, and repeats are harmless', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup({ rowNames: [HOST, WWW] })
  try {
    await openRequest(f, f.serverId, { state: { phase: 'ordering' } })
    const pair = await issuedPair([HOST, WWW])
    await storeIssuedCertificate(f.db, pairFor(pair, f.serverId, HOST), f.deps)
    await handleIssueEvent(f.db, { serverId: f.serverId, requestId: REQUEST_ID, stage: 'issued' })
    const closedAt = (await readState(f))?.endedAt
    assertEquals(typeof closedAt, 'string')
    for (const name of [WWW, HOST, WWW]) {
      const result = await storeIssuedCertificate(f.db, pairFor(pair, f.serverId, name), f.deps)
      assertEquals(result.ok, true, name)
    }
    assertEquals((await readState(f))?.endedAt, closedAt)
    // Another server still cannot use the closed request.
    const other = await storeIssuedCertificate(f.db, pairFor(pair, f.otherServerId, WWW), f.deps)
    assertEquals(other.ok, false)
  } finally {
    await f.cleanup()
  }
})

test('a pair that is not newer than the stored one still counts toward the request', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const newer = await issuedPair([HOST], 90)
    await storeIssuedCertificate(
      f.db,
      {
        serverId: f.serverId,
        hostname: HOST,
        certificatePem: newer.certificatePem,
        privateKeyPem: newer.privateKeyPem,
      },
      f.deps
    )
    await openRequest(f, f.serverId, {
      state: { phase: 'ordering', issuedEventAt: new Date().toISOString() },
    })
    const older = await issuedPair([HOST], 30)
    const result = await storeIssuedCertificate(f.db, withRequest(older, f.serverId), f.deps)
    assertEquals(result.ok, true)
    const state = await readState(f)
    assertEquals(state?.phase, 'issued')
    assertEquals((await readRow(f)).certificatePem, newer.certificatePem)
  } finally {
    await f.cleanup()
  }
})

test('a pair a server captured by itself clears a waiting marker', async () => {
  if (!dbUrl) return skipWithoutDatabase('issued certificate storage tests')
  const f = await setup()
  try {
    const row = await readRow(f)
    await f.db
      .update(tls)
      .set({
        metadata: {
          ...(row.metadata as object),
          acme: {
            managedBy: 'caddy',
            stage: 'waiting',
            warning: 'Waiting for a contact email address.',
          },
        },
      })
      .where(eq(tls.id, f.tlsId))
    const pair = await issuedPair([HOST])
    const result = await storeIssuedCertificate(
      f.db,
      {
        serverId: f.serverId,
        hostname: HOST,
        certificatePem: pair.certificatePem,
        privateKeyPem: pair.privateKeyPem,
      },
      f.deps
    )
    assertEquals(result.ok, true)
    const acme = ((await readRow(f)).metadata as { acme: Record<string, unknown> }).acme
    assertEquals(acme.stage, undefined)
    assertEquals(acme.warning, undefined)
  } finally {
    await f.cleanup()
  }
})
