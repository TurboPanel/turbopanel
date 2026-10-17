import { assertEquals, assertNotEquals } from '@std/assert'
import {
  UncacheableStatementError,
  findUncacheableStatementError,
  isCacheableStatement,
  normaliseStatement,
  statementFingerprint,
  uncacheableReason,
} from './statement-guard.ts'

const test = Deno.test.bind(Deno)

test('plain selects with parameters are cacheable', () => {
  assertEquals(uncacheableReason('select "id" from "server" where "id" = $1 limit $2'), null)
  assertEquals(uncacheableReason('  SELECT 1'), null)
})

test('anything but a select is refused', () => {
  for (const text of [
    'insert into "server" ("id") values ($1)',
    'update "server" set "name" = $1',
    'delete from "server"',
    'with x as (select 1) select * from x',
    'begin',
    'select 1 into "copy"',
  ]) {
    assertNotEquals(uncacheableReason(text), null, text)
  }
})

test('more than one statement is refused, a quoted semicolon is not', () => {
  assertEquals(uncacheableReason('select 1; select 2'), 'more than one statement')
  assertEquals(uncacheableReason('select \';\' from "a;b"'), null)
  assertEquals(uncacheableReason('select 1;'), null)
})

test('row locking clauses are refused', () => {
  for (const clause of ['for update', 'for share', 'for no key update', 'for key share']) {
    assertNotEquals(uncacheableReason(`select 1 from "t" ${clause}`), null, clause)
  }
})

test('volatile functions and keywords are refused wherever they appear', () => {
  const tokens = [
    'now()',
    'now ()',
    'random()',
    'nextval($1)',
    'currval($1)',
    'lastval()',
    'uuidv7()',
    'gen_random_uuid()',
    'clock_timestamp()',
    'statement_timestamp()',
    'timeofday()',
    'current_timestamp',
    'current_date',
    'current_time',
    'localtime',
    'localtimestamp',
    "set_config('a','b',false)",
    'pg_sleep(1)',
    'txid_current()',
    'pg_advisory_lock(1)',
    'pg_try_advisory_lock(1)',
  ]
  for (const token of tokens) {
    assertNotEquals(uncacheableReason(`select ${token}`), null, token)
    // Hyperdrive matches text, so a comment or a literal counts too.
    assertNotEquals(uncacheableReason(`select 1 /* ${token} */`), null, `comment ${token}`)
    assertNotEquals(uncacheableReason(`select '${token}'`), null, `literal ${token}`)
  }
})

test('comments and alternative quoting are refused', () => {
  for (const text of [
    "select 1 /* ' */ ; delete from t where a = '",
    'select 1 -- note',
    'select $$x$$',
    'select $a$;drop$a$',
    "select E'a\\'b'",
  ]) {
    assertNotEquals(uncacheableReason(text), null, text)
  }
})

test('more volatile names are refused', () => {
  for (const text of [
    'select current_user',
    'select session_user',
    'select pg_backend_pid()',
    "select current_setting('a')",
    "select 'now'::timestamp",
    'select current_schema',
    'select uuidv4()',
  ]) {
    assertNotEquals(uncacheableReason(text), null, text)
  }
})

test('similar names are not mistaken for volatile tokens', () => {
  assertEquals(
    isCacheableStatement('select "created_at", "now_playing", "current_dates" from "t"'),
    null === null
  )
})

test('the fingerprint ignores list length and spacing but not the statement', () => {
  const one = 'select "id" from "t" where "id" in ($1) order by "id"'
  const three = 'select "id" from "t"   where "id" in ($1, $2, $3)\n order by "id"'
  assertEquals(statementFingerprint(one), statementFingerprint(three))
  assertNotEquals(
    statementFingerprint(one),
    statementFingerprint(one.replace('"id" in', '"name" in'))
  )
  assertEquals(
    normaliseStatement('select 1 from "t" where "a" in ($1, $2) and "b" = $3 limit $4'),
    'select 1 from "t" where "a" in ($*) and "b" = $1 limit $2'
  )
})

test('the guard error is found under a wrapper', () => {
  const inner = new UncacheableStatementError('x')
  const wrapped = new Error('Failed query', { cause: inner })
  assertEquals(findUncacheableStatementError(wrapped), inner)
  assertEquals(findUncacheableStatementError(new Error('other')), null)
})
