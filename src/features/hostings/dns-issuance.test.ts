/**
 * The DNS ordering gate against a database, through its three readers (the
 * hosting read, the default a name moves to when a tunnel name is opened for
 * direct visitors, the default a new name gets) and the refusal of a saved
 * choice. Skips without TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import {
  loadHostingNameReads,
  refuseUnavailableDnsChoices,
} from '../../client/hostings/name-certificates-routes.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  badge,
  carrier,
  doorway,
  hostname,
  hosting,
  organization,
  server,
} from '../../db/schema.ts'
import { ACME_ISSUE_DNS_FEATURE } from '../../lib/version-wire.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { CredentialReport } from '../tunnels/adapter.ts'
import { setDoorwayLocalOnly } from '../tunnels/doorway-reach.ts'
import { insertBadge, insertCarrier, sealToken } from '../tunnels/records.ts'
import { replaceHostingHostnames } from '../servers/hostname-records.ts'
import { NAME, type Scenario, withScenario } from '../tunnels/nudge-scenario.test.support.ts'
import { loadDnsIssuance } from './dns-issuance.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

function report(zoneName: string): CredentialReport {
  return {
    accounts: [],
    zones: [],
    accountVisible: true,
    capabilities: { tunnels: false, dns: [{ id: 'zone-1', name: zoneName }], certificates: [] },
    missing: [],
    token: { kind: 'account', id: null, status: 'active', expiresAt: null },
  }
}

async function addToken(s: Scenario, zoneName: string) {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const owner = await insertCarrier(s.db, {
    organizationId: s.organizationId,
    provider: 'cloudflare',
    name: 'Main',
    externalAccountId: 'acct-1',
  })
  await insertBadge(s.db, {
    organizationId: s.organizationId,
    carrier: owner,
    label: 'dns-token',
    sealed: await sealToken(secrets, 'dns-token'),
    lastFour: 'oken',
    report: report(zoneName),
  })
}

/** The scenario, with the tokens a test added removed again before it is torn down. */
async function withGate(fn: (s: Scenario) => Promise<void>): Promise<void> {
  await withScenario({}, async (s) => {
    try {
      await fn(s)
    } finally {
      const carriers = await s.db
        .select({ id: carrier.id })
        .from(carrier)
        .where(eq(carrier.organizationId, s.organizationId))
      await s.db.delete(badge).where(
        inArray(
          badge.carrierId,
          carriers.map((c) => c.id)
        )
      )
      await s.db.delete(carrier).where(eq(carrier.organizationId, s.organizationId))
    }
  })
}

async function giveFeature(s: Scenario, serverId: string) {
  await s.db
    .update(server)
    .set({ daemon: { projection: { features: [ACME_ISSUE_DNS_FEATURE] } } })
    .where(eq(server.id, serverId))
}

async function serviceOf(s: Scenario, hostingId: string): Promise<string> {
  const [row] = await s.db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
  return row!.serviceId
}

async function dnsOption(s: Scenario, hostingId: string, name: string) {
  const [row] = await s.db
    .select({ id: hosting.id, serviceId: hosting.serviceId, options: hosting.options })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
  const reads = await loadHostingNameReads(s.db, s.organizationId, [row!])
  const read = (reads.get(hostingId) ?? []).find((n) => n.hostname === name)
  const option = read?.certificateOptions.options.find((o) => o.certificate === 'letsencrypt_dns')
  return { option, default: read?.certificateOptions.default }
}

function ctx(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('the hosting read offers DNS only once every precondition holds', async () => {
  await withGate(async (s) => {
    const off = await dnsOption(s, s.hostingAId, NAME)
    assertEquals(off.option?.available, false)
    assertEquals(off.option?.reason, "Let's Encrypt is not turned on for this organization")

    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    assertEquals(
      (await dnsOption(s, s.hostingAId, NAME)).option?.reason,
      `No DNS token covers ${NAME}`
    )

    await addToken(s, 'example.net')
    assertEquals(
      (await dnsOption(s, s.hostingAId, NAME)).option?.reason,
      `No DNS token covers ${NAME}`
    )
  })
})

test('a covering token alone is not enough: a serving daemon must list the feature', async () => {
  await withGate(async (s) => {
    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    await addToken(s, 'example.com')
    assertEquals(
      (await dnsOption(s, s.hostingAId, NAME)).option?.reason,
      'No server serving this name can order over DNS yet'
    )
    // A daemon on the other site does not serve this one.
    await giveFeature(s, s.siteBId)
    assertEquals((await dnsOption(s, s.hostingAId, NAME)).option?.available, false)
    await giveFeature(s, s.siteAId)
    const on = await dnsOption(s, s.hostingAId, NAME)
    assertEquals(on.option?.available, true)
    assertEquals(on.option?.reason, undefined)
  })
})

test('opening a tunnel name for direct visitors moves it to DNS only when the gate allows it', async () => {
  await withGate(async (s) => {
    await s.db
      .update(hosting)
      .set({ options: { hostnames: [NAME], bind: 'datacenter' } })
      .where(eq(hosting.id, s.hostingAId))
    const reopen = async (): Promise<string | null> => {
      await s.db.update(doorway).set({ isLocalOnly: true }).where(eq(doorway.id, s.doorwayId))
      await s.db
        .update(hostname)
        .set({ certificate: 'cloudflare_origin', tlsId: null })
        .where(eq(hostname.hostingId, s.hostingAId))
      const [row] = await s.db.select().from(doorway).where(eq(doorway.id, s.doorwayId))
      await setDoorwayLocalOnly(s.db, s.organizationId, row!, false)
      const [stored] = await s.db
        .select({ certificate: hostname.certificate })
        .from(hostname)
        .where(eq(hostname.hostingId, s.hostingAId))
      return stored?.certificate ?? null
    }
    assertEquals(await reopen(), 'self_signed')
    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    await addToken(s, 'example.com')
    await giveFeature(s, s.siteAId)
    assertEquals(await reopen(), 'letsencrypt_dns')
  })
})

test('a new name gets DNS as its default only when the gate allows it, name by name', async () => {
  await withGate(async (s) => {
    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    await addToken(s, 'example.com')
    await giveFeature(s, s.siteAId)
    await replaceHostingHostnames(s.db, s.hostingAId, s.organizationId, [
      NAME,
      'app.example.com',
      'app.example.org',
    ])
    const rows = await s.db
      .select({ hostname: hostname.hostname, certificate: hostname.certificate })
      .from(hostname)
      .where(eq(hostname.hostingId, s.hostingAId))
    const byName = new Map(rows.map((r) => [r.hostname, r.certificate]))
    assertEquals(byName.get('app.example.com'), 'letsencrypt_dns')
    assertEquals(byName.get('app.example.org'), 'letsencrypt_http')
  })
})

test('the gate answers each service it was asked about on its own servers', async () => {
  await withGate(async (s) => {
    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    await addToken(s, 'example.com')
    await giveFeature(s, s.siteBId)
    const a = await serviceOf(s, s.hostingAId)
    const b = await serviceOf(s, s.hostingBId)
    const gate = await loadDnsIssuance(s.db, s.organizationId, [a, b])
    assertEquals(gate(a, NAME).dnsIssuance, false)
    assertEquals(gate(b, NAME).dnsIssuance, true)
  })
})

test('picking DNS for a name the gate does not offer it for is refused with the reason', async () => {
  await withGate(async (s) => {
    const serviceId = await serviceOf(s, s.hostingAId)
    const choices = new Map([
      ['app.example.com', { certificate: 'letsencrypt_dns' as const, tlsId: null }],
    ])
    const site = { serviceId, hostingId: s.hostingAId }
    const refused = await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, choices)
    assertEquals(refused?.status, 409)
    assertEquals(await refused?.json(), {
      error: 'dns_issuance_unavailable',
      message: "app.example.com: Let's Encrypt is not turned on for this organization",
    })

    await s.db
      .update(organization)
      .set({ isAcmeEnabled: true })
      .where(eq(organization.id, s.organizationId))
    await addToken(s, 'example.com')
    const noServer = await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, choices)
    assertEquals(
      ((await noServer?.json()) as { message: string }).message,
      'app.example.com: No server serving this name can order over DNS yet'
    )

    await giveFeature(s, s.siteAId)
    assertEquals(
      await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, choices),
      null
    )
  })
})

test('a stored DNS choice and a choice that pins a certificate are not refused again', async () => {
  await withGate(async (s) => {
    const serviceId = await serviceOf(s, s.hostingAId)
    await s.db
      .update(hostname)
      .set({ certificate: 'letsencrypt_dns' })
      .where(eq(hostname.hostingId, s.hostingAId))
    const site = { serviceId, hostingId: s.hostingAId }
    const stored = new Map([[NAME, { certificate: 'letsencrypt_dns' as const, tlsId: null }]])
    assertEquals(
      await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, stored),
      null
    )
    const pinned = new Map([
      [
        'other.example.com',
        { certificate: 'letsencrypt_dns' as const, tlsId: crypto.randomUUID() },
      ],
    ])
    assertEquals(
      await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, pinned),
      null
    )
    const other = new Map([
      ['other.example.com', { certificate: 'letsencrypt_http' as const, tlsId: null }],
    ])
    assertEquals(
      await refuseUnavailableDnsChoices(ctx(), s.db, s.organizationId, site, other),
      null
    )
  })
})
