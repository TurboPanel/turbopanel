import { assertEquals } from '@std/assert'
import { decidePrincipalIds, parsePrincipalIdTaken, type PlacementIdRow } from './principal-ids.ts'
import { parsePrincipalIdReports } from '../../contracts/commands/schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = 'server-a'
const B = 'server-b'
const row = (overrides: Partial<PlacementIdRow> & { serverId: string }): PlacementIdRow => ({
  state: 'present',
  uid: null,
  gid: null,
  ...overrides,
})

test('decidePrincipalIds: a principal with no placement is new and gets an allocation', () => {
  assertEquals(decidePrincipalIds([], A), { kind: 'allocate' })
})

test('decidePrincipalIds: a second server reuses the id the principal already has', () => {
  const rows = [row({ serverId: A, uid: 30001, gid: 30001 })]
  assertEquals(decidePrincipalIds(rows, B), {
    kind: 'use',
    uid: 30001,
    gid: 30001,
  })
})

test('decidePrincipalIds: an account already present here is never given a new id', () => {
  assertEquals(decidePrincipalIds([row({ serverId: A })], A), { kind: 'none' })
  assertEquals(decidePrincipalIds([row({ serverId: A, uid: 15004, gid: 15004 })], A), {
    kind: 'use',
    uid: 15004,
    gid: 15004,
  })
})

test('decidePrincipalIds: an older account with no reported id stays on the host pick', () => {
  assertEquals(decidePrincipalIds([row({ serverId: A })], B), { kind: 'none' })
  assertEquals(decidePrincipalIds([row({ serverId: A, state: 'retiring' })], B), { kind: 'none' })
})

test('decidePrincipalIds: pending or absent rows without ids do not block a new allocation', () => {
  assertEquals(decidePrincipalIds([row({ serverId: A, state: 'pending' })], A), {
    kind: 'allocate',
  })
  assertEquals(decidePrincipalIds([row({ serverId: A, state: 'absent' })], B), {
    kind: 'allocate',
  })
})

test('decidePrincipalIds: an id remembered on an absent placement is still the principal id', () => {
  const rows = [row({ serverId: A, state: 'absent', uid: 30002, gid: 30002 })]
  assertEquals(decidePrincipalIds(rows, B), {
    kind: 'use',
    uid: 30002,
    gid: 30002,
  })
})

test('parsePrincipalIdTaken reads the daemon refusal and ignores other errors', () => {
  const principalId = '01936b3e-aaaa-7bbb-8ccc-123456789abc'
  assertEquals(
    parsePrincipalIdTaken(
      `principal_id_taken kind=uid id=30001 principalId=${principalId}: the uid 30001 is in use`
    ),
    { kind: 'uid', id: 30001, principalId }
  )
  assertEquals(parsePrincipalIdTaken('Failed to create principal user'), null)
})

test('parsePrincipalIdReports keeps well-formed rows and drops the rest', () => {
  assertEquals(
    parsePrincipalIdReports([
      { principalId: 'p1', uid: 30001, gid: 30001 },
      { principalId: 'p2', uid: 'x', gid: 1 },
      { principalId: 'p3', uid: 0, gid: 5 },
      { uid: 5, gid: 5 },
    ]),
    [{ principalId: 'p1', uid: 30001, gid: 30001 }]
  )
  assertEquals(parsePrincipalIdReports(undefined), undefined)
  assertEquals(parsePrincipalIdReports([]), undefined)
})
