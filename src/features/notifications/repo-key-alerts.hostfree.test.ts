import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { describeEvent, eventAudience, eventIsUrgent, eventScope, eventSeverity } from './events.ts'
import type { emitNotification } from './emit.ts'
import { handleRepoKeyChanged, shortFingerprint, shortFingerprintList } from './repo-key-alerts.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

const OLD = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
const NEW = 'abcdef0123456789abcdef0123456789abcdef01'

type Emitted = Parameters<typeof emitNotification>[2]

/** A database that answers the one server lookup the handler makes. */
function fakeDb(rows: Array<{ organizationId: string | null; name: string }>): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  }
  return { select: () => chain } as unknown as Db
}

test('the event is a warning for managers, scoped to the organization, and sent at once', () => {
  assertEquals(eventSeverity('server.repo_key_changed'), 'warning')
  assertEquals(eventScope('server.repo_key_changed'), 'organization')
  assertEquals(eventAudience('server.repo_key_changed'), 'managers')
  assertEquals(eventIsUrgent('server.repo_key_changed'), true)
})

test('the sentence names the source, the server and both fingerprints in plain words', () => {
  const { title, body } = describeEvent('server.repo_key_changed', {
    keyName: 'docker',
    serverName: 'web-1',
    expected: 'AAAA',
    got: 'BBBB',
  })
  assertEquals(title, 'The docker signing key changed on web-1')
  assertEquals(body?.includes('expected AAAA, got BBBB'), true)
  assertEquals(body?.includes('still checked against that key'), true)
})

test('the sentence reads from an empty context', () => {
  const { title } = describeEvent('server.repo_key_changed')
  assertEquals(title, 'The software source signing key changed on a server')
})

test('fingerprints are shortened to the last 16 digits, upper case', () => {
  assertEquals(shortFingerprint(NEW), 'CDEF0123456789ABCDEF01'.slice(-16))
  assertEquals(shortFingerprint(`  ${OLD.toLowerCase()} `), OLD.slice(-16))
})

test('a list shows two fingerprints and counts the rest', () => {
  assertEquals(shortFingerprintList([OLD]), OLD.slice(-16))
  assertEquals(
    shortFingerprintList([OLD, NEW]),
    `${OLD.slice(-16)}, ${NEW.slice(-16).toUpperCase()}`
  )
  assertEquals(shortFingerprintList([OLD, OLD, NEW]).endsWith(' and 1 more'), true)
})

test('a report raises one organization alert about the server', async () => {
  const sent: Emitted[] = []
  const raised = await handleRepoKeyChanged(
    fakeDb([{ organizationId: 'org-1', name: 'web-1' }]),
    undefined,
    'srv-1',
    { keyName: 'docker', expected: [OLD], got: NEW },
    {
      emit: (_db, _secrets, payload) => {
        sent.push(payload)
        return Promise.resolve(undefined as never)
      },
    }
  )
  assertEquals(raised, true)
  assertEquals(sent.length, 1)
  assertEquals(sent[0].event, 'server.repo_key_changed')
  assertEquals(sent[0].organizationId, 'org-1')
  assertEquals(sent[0].targetType, 'server')
  assertEquals(sent[0].targetId, 'srv-1')
  assertEquals(sent[0].context, {
    keyName: 'docker',
    serverName: 'web-1',
    expected: OLD.slice(-16),
    got: NEW.slice(-16).toUpperCase(),
  })
})

test('an unassigned or missing server raises nothing', async () => {
  const never = () => {
    throw new Error('must not emit')
  }
  const report = { keyName: 'docker', expected: [OLD], got: NEW }
  assertEquals(
    await handleRepoKeyChanged(
      fakeDb([{ organizationId: null, name: 'x' }]),
      undefined,
      's',
      report,
      {
        emit: never,
      }
    ),
    false
  )
  assertEquals(
    await handleRepoKeyChanged(fakeDb([]), undefined, 's', report, { emit: never }),
    false
  )
})

test('a failing emitter never throws into the inbound path', async () => {
  const raised = await handleRepoKeyChanged(
    fakeDb([{ organizationId: 'org-1', name: 'web-1' }]),
    undefined,
    'srv-1',
    { keyName: 'docker', expected: [OLD], got: NEW },
    { emit: () => Promise.reject(new Error('boom')) }
  )
  assertEquals(raised, false)
})
