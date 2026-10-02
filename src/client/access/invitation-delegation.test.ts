/**
 * Invitations confer no more than the inviter holds (audit P1-1).
 *
 * Real database, real access router. Each case seeds an inviter with one grant,
 * gives the invited team zero or more grants of its own, then sends a
 * grant-less invitation and (when it is accepted) checks what the invitee
 * actually ends up holding. Skips without TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { grant, invitation, organization, team, teammate, user } from '../../db/schema.ts'
import type { EmailQueue } from '../../features/email/types.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { can } from '../authz/index.ts'
import { canAccessOrganization, ORG_ID_HEADER } from '../org-context.ts'
import { acceptInvitationForUser } from './invitation-accept.ts'
import { registerAccessRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>
type Scope = 'organization' | 'team'
type GrantSeed = { scope: Scope; permission: string }

type Case = {
  name: string
  inviter: GrantSeed
  /** Grants the invited team itself holds, conferred on every member. */
  teamGrants: GrantSeed[]
  /** Grants given to the team after the invitation went out. */
  laterTeamGrants?: GrantSeed[]
  createStatus: number
  /** What accepting answers; omitted when the create was refused. */
  accept?: 'ok' | 'invalid_grant'
}

const CASES: Case[] = [
  {
    name: 'team manager invites into a plain team: invitee gets membership, no org grant',
    inviter: { scope: 'team', permission: 'team:manage' },
    teamGrants: [],
    createStatus: 200,
    accept: 'ok',
  },
  {
    name: 'org manager invites into a plain team (the invite form): membership only',
    inviter: { scope: 'organization', permission: 'organization:manage' },
    teamGrants: [],
    createStatus: 200,
    accept: 'ok',
  },
  {
    name: 'team manager cannot invite into a team that holds organization:manage',
    inviter: { scope: 'team', permission: 'team:manage' },
    teamGrants: [{ scope: 'organization', permission: 'organization:manage' }],
    createStatus: 403,
  },
  {
    name: 'org manager cannot invite into a team that holds organization:own',
    inviter: { scope: 'organization', permission: 'organization:manage' },
    teamGrants: [{ scope: 'organization', permission: 'organization:own' }],
    createStatus: 403,
  },
  {
    name: 'org owner may invite into a team that holds organization:own',
    inviter: { scope: 'organization', permission: 'organization:own' },
    teamGrants: [{ scope: 'organization', permission: 'organization:own' }],
    createStatus: 200,
    accept: 'ok',
  },
  {
    name: 'accept re-checks: a team grant added after the invite beyond the inviter is refused',
    inviter: { scope: 'organization', permission: 'organization:manage' },
    teamGrants: [],
    laterTeamGrants: [{ scope: 'organization', permission: 'organization:own' }],
    createStatus: 200,
    accept: 'invalid_grant',
  },
]

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  cookie: string
  organizationId: string
  teamId: string
  homeTeamId: string
  inviterId: string
  inviteeId: string
}

async function seedGrants(db: Db, fx: Fixture, actor: 'user' | 'team', seeds: GrantSeed[]) {
  const rows = seeds.map((seed) => ({
    entityType: seed.scope,
    entityId: seed.scope === 'organization' ? fx.organizationId : fx.teamId,
    actorType: actor,
    actorId: actor === 'user' ? fx.inviterId : fx.teamId,
    permission: seed.permission,
  }))
  if (rows.length > 0) await db.insert(grant).values(rows)
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const queue: EmailQueue = { enqueue: () => Promise.resolve() }
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('emailQueue', queue)
    return next()
  })
  registerAccessRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const [org] = await db
    .insert(organization)
    .values({ name: 'Invite Delegation Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  // The invited team, and a second "home" team that only gives a team-scoped
  // inviter a way into the organization (membership confers org access).
  const [teamRow, homeTeam] = await db
    .insert(team)
    .values([
      { name: 'Invite Delegation Team', organizationId },
      { name: 'Invite Delegation Home', organizationId },
    ])
    .returning({ id: team.id })
  const users = await db
    .insert(user)
    .values(
      ['inviter', 'invitee'].map((label) => ({
        email: `invite-delegation-${label}-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      }))
    )
    .returning({ id: user.id })
  const [inviterId, inviteeId] = [users[0]!.id, users[1]!.id]
  const { token } = await createSession(db, inviterId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const fx = {
    db,
    app,
    cookie,
    organizationId,
    teamId: teamRow!.id,
    homeTeamId: homeTeam!.id,
    inviterId,
    inviteeId,
  }
  try {
    await fn(fx)
  } finally {
    const actors = [inviterId, inviteeId, fx.teamId]
    await db.delete(invitation).where(eq(invitation.teamId, fx.teamId))
    await db.delete(teammate).where(inArray(teammate.teamId, [fx.teamId, fx.homeTeamId]))
    await db.delete(grant).where(or(inArray(grant.actorId, actors), eq(grant.entityId, fx.teamId)))
    await db.delete(team).where(inArray(team.id, [fx.teamId, fx.homeTeamId]))
    await db.delete(user).where(inArray(user.id, [inviterId, inviteeId]))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function createInvitation(fx: Fixture): Promise<Response> {
  return await fx.app.request('/invitations', {
    method: 'POST',
    headers: {
      Cookie: fx.cookie,
      [ORG_ID_HEADER]: fx.organizationId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId: fx.teamId,
      email: `invitee-${crypto.randomUUID()}@example.com`,
    }),
  })
}

async function runCase(entry: Case, fx: Fixture): Promise<void> {
  await seedGrants(fx.db, fx, 'user', [entry.inviter])
  // A team-scoped manager reaches the organization through another team.
  if (entry.inviter.scope === 'team') {
    await fx.db.insert(teammate).values({ teamId: fx.homeTeamId, userId: fx.inviterId })
  }
  await seedGrants(fx.db, fx, 'team', entry.teamGrants)

  const created = await createInvitation(fx)
  assertEquals(created.status, entry.createStatus, await created.clone().text())
  if (entry.accept === undefined) return
  const { id } = (await created.json()) as { id: string }

  await seedGrants(fx.db, fx, 'team', entry.laterTeamGrants ?? [])
  const accepted = await acceptInvitationForUser(fx.db, id, fx.inviteeId)
  assertEquals('ok' in accepted ? 'ok' : accepted.error, entry.accept)

  const direct = await fx.db
    .select({ permission: grant.permission })
    .from(grant)
    .where(eq(grant.actorId, fx.inviteeId))
  assertEquals(direct, [], 'a grant-less invitation must not write user grants')
  // The invite flow still works: an accepted invitee can open the organization.
  assertEquals(
    await canAccessOrganization(fx.db, fx.inviteeId, fx.organizationId),
    entry.accept === 'ok'
  )
  const managesOrg = await can(
    fx.db,
    fx.inviteeId,
    'organization:manage',
    'organization',
    fx.organizationId
  )
  const teamConfersOrg = entry.teamGrants.some((seed) => seed.scope === 'organization')
  assertEquals(managesOrg, entry.accept === 'ok' && teamConfersOrg)
}

for (const entry of CASES) {
  test(`invitation delegation: ${entry.name}`, async () => {
    if (!dbUrl) {
      console.warn('Skipping invitation delegation tests: TURBOPANEL_DATABASE_URL not set')
      return
    }
    await withFixture((fx) => runCase(entry, fx))
  })
}
