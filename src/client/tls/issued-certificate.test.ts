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
import { replaces, storeIssuedCertificate } from './issued-certificate.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HOST = 'shop.example.com'

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
  const db = createDenoDb()
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
      status: 'managed',
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
    assertEquals(row.status, 'managed')
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
      status: 400,
    })
    assertEquals(await send(wrongName.certificatePem, wrongName.privateKeyPem), {
      ok: false,
      error: 'certificate_not_for_hostname',
      status: 400,
    })
    const farFuture = () => new Date(Date.now() + 400 * 86_400_000)
    assertEquals(await send(good.certificatePem, good.privateKeyPem, farFuture), {
      ok: false,
      error: 'certificate_expired',
      status: 400,
    })
    const ca = await mintOrganizationCa({
      organizationId: crypto.randomUUID(),
    })
    assertEquals(await send(ca.certificatePem, ca.privateKeyPem), {
      ok: false,
      error: 'certificate_not_for_hostname',
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
      error: 'invalid_certificate',
      status: 400,
    })
    const longChain = Array(7).fill(good.certificatePem).join('\n')
    assertEquals(await send(HOST, longChain, good.privateKeyPem), {
      ok: false,
      error: 'invalid_certificate',
      status: 400,
    })
    for (const bad of ['*.example.com', '../x', 'a b', '', 'a..b']) {
      assertEquals(await send(bad, good.certificatePem, good.privateKeyPem), {
        ok: false,
        error: 'invalid_hostname',
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
      { ok: false, error: 'server_not_in_organization', status: 403 }
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
