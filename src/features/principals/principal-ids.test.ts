import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { loadPrincipalMaterial } from '../../client/environments/deploy-prepare.ts'
import { organization, principal, principalPlacement, server } from '../../db/schema.ts'
import {
  PRINCIPAL_ID_BAND_MAX,
  PRINCIPAL_ID_BAND_MIN,
  recordReportedPrincipalIds,
  releaseRefusedPrincipalIds,
  resolvePrincipalIds,
} from './principal-ids.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Fixtures = {
  db: ReturnType<typeof createDenoDb>
  serverIds: [string, string]
  principalIds: [string, string, string]
}

async function withFixtures(fn: (ctx: Fixtures) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('principal id allocation tests')
    return
  }
  const db = createDenoDb()
  const suffix = crypto.randomUUID().slice(0, 8)
  const [org] = await db
    .insert(organization)
    .values({ name: `Principal Ids Org ${suffix}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const servers = await db
    .insert(server)
    .values([
      { organizationId, name: `ids-a-${suffix}` },
      { organizationId, name: `ids-b-${suffix}` },
    ])
    .returning({ id: server.id })
  const principals = await db
    .insert(principal)
    .values(
      ['one', 'two', 'three'].map((name) => ({
        organizationId,
        username: `pi_${name}_${suffix}`,
        appliedUsername: `pi_${name}_${suffix}`,
      }))
    )
    .returning({ id: principal.id })
  try {
    await fn({
      db,
      serverIds: [servers[0]!.id, servers[1]!.id],
      principalIds: [principals[0]!.id, principals[1]!.id, principals[2]!.id],
    })
  } finally {
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

const homeOf = (id: string) => `/srv/users/${id.slice(0, 8)}`

test('a new principal gets one id from the sequence and every server gets the same one', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1, p2] }) => {
    const first = await resolvePrincipalIds(
      db,
      a,
      [
        { principalId: p1, home: homeOf(p1) },
        { principalId: p2, home: homeOf(p2) },
      ],
      { allocate: true }
    )
    const ids1 = first.get(p1)!
    const ids2 = first.get(p2)!
    assert(ids1.uid >= PRINCIPAL_ID_BAND_MIN && ids1.uid <= PRINCIPAL_ID_BAND_MAX)
    assertEquals(ids1.uid, ids1.gid)
    assertNotEquals(ids1.uid, ids2.uid)

    // Recorded on a pending placement, so the second server sees it.
    const second = await resolvePrincipalIds(
      db,
      b,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    assertEquals(second.get(p1), ids1)

    // Asking again for the first server does not take another number.
    const again = await resolvePrincipalIds(
      db,
      a,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    assertEquals(again.get(p1), ids1)
  })
})

test('concurrent requests for one principal on two servers settle on one id', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1] }) => {
    const request = [{ principalId: p1, home: homeOf(p1) }]
    const [onA, onB] = await Promise.all([
      resolvePrincipalIds(db, a, request, { allocate: true }),
      resolvePrincipalIds(db, b, request, { allocate: true }),
    ])
    assertEquals(onA.get(p1), onB.get(p1))
    assert(onA.get(p1) !== undefined)
  })
})

test('a preview takes no number and writes nothing', async () => {
  await withFixtures(async ({ db, serverIds: [a], principalIds: [p1] }) => {
    const result = await resolvePrincipalIds(
      db,
      a,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: false,
      }
    )
    assertEquals(result.size, 0)
    const rows = await db
      .select({ id: principalPlacement.id })
      .from(principalPlacement)
      .where(eq(principalPlacement.principalId, p1))
    assertEquals(rows.length, 0)
  })
})

test('an older account without a reported id is left to the host, then filled from its report', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1] }) => {
    await db.insert(principalPlacement).values({
      principalId: p1,
      serverId: a,
      state: 'present',
      home: homeOf(p1),
      source: 'manual',
    })
    const sent = await resolvePrincipalIds(
      db,
      a,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    assertEquals(sent.size, 0)
    const elsewhere = await resolvePrincipalIds(
      db,
      b,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    assertEquals(elsewhere.size, 0)

    await recordReportedPrincipalIds(db, a, [
      {
        principalId: p1,
        uid: 15007,
        gid: 15007,
      },
    ])
    // A different report later never renumbers what is recorded.
    await recordReportedPrincipalIds(db, a, [
      {
        principalId: p1,
        uid: 15999,
        gid: 15999,
      },
    ])
    const [row] = await db
      .select({ uid: principalPlacement.uid, gid: principalPlacement.gid })
      .from(principalPlacement)
      .where(eq(principalPlacement.serverId, a))
    assertEquals(row, { uid: 15007, gid: 15007 })

    // Now the other server asks for the same id.
    const later = await resolvePrincipalIds(
      db,
      b,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    assertEquals(later.get(p1), { uid: 15007, gid: 15007 })
  })
})

test('a number another principal already holds on some host is skipped, not reused', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1, p2, p3] }) => {
    const probe = await resolvePrincipalIds(
      db,
      a,
      [
        {
          principalId: p1,
          home: homeOf(p1),
        },
      ],
      {
        allocate: true,
      }
    )
    const held = probe.get(p1)!.uid + 1
    // The next number is held by an older account on another host.
    await db.insert(principalPlacement).values({
      principalId: p2,
      serverId: b,
      state: 'present',
      uid: held,
      gid: held,
      home: homeOf(p2),
      source: 'manual',
    })
    const got = await resolvePrincipalIds(
      db,
      a,
      [
        {
          principalId: p3,
          home: homeOf(p3),
        },
      ],
      {
        allocate: true,
      }
    )
    assert(got.get(p3)!.uid > held)
  })
})

test('a refused id is released only while no account has it', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1, p2] }) => {
    const ids = (
      await resolvePrincipalIds(
        db,
        a,
        [
          {
            principalId: p1,
            home: homeOf(p1),
          },
        ],
        { allocate: true }
      )
    ).get(p1)!
    const refusal = (id: string) =>
      `principal_id_taken kind=uid id=${ids.uid} principalId=${id}: the uid is used`
    assertEquals(await releaseRefusedPrincipalIds(db, refusal(p1)), true)
    const fresh = (
      await resolvePrincipalIds(
        db,
        a,
        [
          {
            principalId: p1,
            home: homeOf(p1),
          },
        ],
        { allocate: true }
      )
    ).get(p1)!
    assertNotEquals(fresh.uid, ids.uid)

    // An account that exists keeps its id: the refusal changes nothing.
    await db.insert(principalPlacement).values({
      principalId: p2,
      serverId: b,
      state: 'present',
      uid: 15010,
      gid: 15010,
      home: homeOf(p2),
      source: 'manual',
    })
    assertEquals(
      await releaseRefusedPrincipalIds(
        db,
        `principal_id_taken kind=uid id=15010 principalId=${p2}: x`
      ),
      false
    )
    const [row] = await db
      .select({ uid: principalPlacement.uid })
      .from(principalPlacement)
      .where(eq(principalPlacement.principalId, p2))
    assertEquals(row?.uid, 15010)
  })
})

test('principal material carries the central id, keeps an operator override, and previews take none', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1, p2] }) => {
    await db
      .update(principal)
      .set({ options: { uid: 45000, gid: 45000 } })
      .where(eq(principal.id, p2))

    const preview = await loadPrincipalMaterial(db, [p1], { serverId: a, allocate: false })
    assertEquals(preview[0]?.uid, undefined)

    const onA = await loadPrincipalMaterial(db, [p1, p2], { serverId: a, allocate: true })
    const onB = await loadPrincipalMaterial(db, [p1, p2], { serverId: b, allocate: true })
    const byId = (rows: typeof onA, id: string) => rows.find((row) => row.principalId === id)!
    assert(byId(onA, p1).uid !== undefined)
    assertEquals(byId(onA, p1).idSource, 'central')
    assertEquals(byId(onA, p2).idSource, undefined)
    assertEquals(byId(onB, p1).uid, byId(onA, p1).uid)
    assertEquals(byId(onB, p1).gid, byId(onA, p1).gid)
    assertEquals(byId(onA, p2).uid, 45000)
    assertEquals(byId(onB, p2).uid, 45000)

    // Without a target nothing is allocated (the old behaviour).
    const bare = await loadPrincipalMaterial(db, [p1])
    assertEquals(bare[0]?.uid, undefined)
  })
})

test('after a refusal the principal takes a new pick on every server, never the refused one', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1] }) => {
    const request = [{ principalId: p1, home: homeOf(p1) }]
    const ids = (await resolvePrincipalIds(db, a, request, { allocate: true })).get(p1)!
    await db.insert(principalPlacement).values({
      principalId: p1,
      serverId: b,
      state: 'pending',
      uid: ids.uid,
      gid: ids.gid,
      home: homeOf(p1),
      source: 'manual',
    })
    const refusal = `principal_id_taken kind=gid id=${ids.gid} principalId=${p1}: x`
    assertEquals(await releaseRefusedPrincipalIds(db, refusal), true)
    const again = (await resolvePrincipalIds(db, b, request, { allocate: true })).get(p1)!
    assertNotEquals(again.uid, ids.uid)
    const onA = (await resolvePrincipalIds(db, a, request, { allocate: true })).get(p1)!
    assertEquals(onA, again)
  })
})

test('a report whose uid another principal only picked frees that pick instead of failing', async () => {
  await withFixtures(async ({ db, serverIds: [a], principalIds: [p1, p2] }) => {
    const picked = (
      await resolvePrincipalIds(db, a, [{ principalId: p1, home: homeOf(p1) }], { allocate: true })
    ).get(p1)!
    await db.insert(principalPlacement).values({
      principalId: p2,
      serverId: a,
      state: 'pending',
      home: homeOf(p2),
      source: 'manual',
    })
    await recordReportedPrincipalIds(db, a, [{ principalId: p2, uid: picked.uid, gid: picked.gid }])
    const rows = await db
      .select({ principalId: principalPlacement.principalId, uid: principalPlacement.uid })
      .from(principalPlacement)
      .where(eq(principalPlacement.serverId, a))
    assertEquals(rows.find((r) => r.principalId === p2)?.uid, picked.uid)
    assertEquals(rows.find((r) => r.principalId === p1)?.uid, null)
  })
})

test('a row holding only the control plane pick is corrected by the host report; a present row is not', async () => {
  await withFixtures(async ({ db, serverIds: [a, b], principalIds: [p1] }) => {
    const request = [{ principalId: p1, home: homeOf(p1) }]
    const chosen = (await resolvePrincipalIds(db, a, request, { allocate: true })).get(p1)!
    // The account already existed on the host under other ids.
    await recordReportedPrincipalIds(db, a, [{ principalId: p1, uid: 15021, gid: 15022 }])
    const [fixed] = await db
      .select({ uid: principalPlacement.uid, gid: principalPlacement.gid })
      .from(principalPlacement)
      .where(eq(principalPlacement.serverId, a))
    assertEquals(fixed, { uid: 15021, gid: 15022 })
    assertNotEquals(fixed!.uid, chosen.uid)

    // Once present, a different report changes nothing.
    await db
      .update(principalPlacement)
      .set({ state: 'present' })
      .where(eq(principalPlacement.serverId, a))
    await recordReportedPrincipalIds(db, a, [{ principalId: p1, uid: 15999, gid: 15999 }])
    const [kept] = await db
      .select({ uid: principalPlacement.uid })
      .from(principalPlacement)
      .where(eq(principalPlacement.serverId, a))
    assertEquals(kept?.uid, 15021)

    // The next server is sent the confirmed ids.
    const next = await resolvePrincipalIds(db, b, request, { allocate: true })
    assertEquals(next.get(p1), { uid: 15021, gid: 15022 })
  })
})

test('a number pinned by an operator on a principal is skipped by the sequence', async () => {
  await withFixtures(async ({ db, serverIds: [a], principalIds: [p1, p2, p3] }) => {
    const first = (
      await resolvePrincipalIds(db, a, [{ principalId: p1, home: homeOf(p1) }], { allocate: true })
    ).get(p1)!
    const pinned = first.uid + 1
    await db
      .update(principal)
      .set({ options: { uid: pinned, gid: pinned } })
      .where(eq(principal.id, p2))
    const got = (
      await resolvePrincipalIds(db, a, [{ principalId: p3, home: homeOf(p3) }], { allocate: true })
    ).get(p3)!
    assert(got.uid > pinned)
  })
})
