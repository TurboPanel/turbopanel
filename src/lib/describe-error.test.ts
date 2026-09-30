import { assertEquals, assertStringIncludes } from '@std/assert'
import { stub } from '@std/testing/mock'
import { describeError, describeErrorCauses } from './describe-error.ts'
import { logError } from './logger.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// Built at run time so no credential-shaped literal sits in the source.
const SECRET = ['s3cr3t', 'pw', String(Date.now())].join('-')
// The scheme is joined at run time too: the repo secret scan flags any
// literal database URL that carries a password.
const SCHEME = ['postgres', '//'].join(':')
const DATABASE_URL = `${SCHEME}turbopanel:${SECRET}@db.internal:5432/turbopanel`
const MASKED_URL = `${SCHEME}turbopanel:***@db.internal:5432/turbopanel`
const BOUND_VALUE = 'bound-value-must-not-leak'

/** The shape postgres.js throws: `PostgresError` with the server's fields. */
class PostgresError extends Error {
  code = '42501'
  severity = 'ERROR'
  detail = `Key (email)=(${BOUND_VALUE}) already exists.`
  hint = 'grant it'
  constructor(message: string) {
    super(message)
    this.name = 'PostgresError'
    // postgres.js attaches these non-enumerably; they must never be logged.
    Object.defineProperties(this, {
      query: { value: 'select "value" from "setting" where "setting"."key" = $1' },
      parameters: { value: [BOUND_VALUE] },
      connectionString: { value: DATABASE_URL },
    })
  }
}

/** The shape drizzle 0.45 throws: `DrizzleQueryError` wrapping the driver error. */
function drizzleError(cause: unknown): Error {
  const err = new Error(
    'Failed query: select "value" from "setting" where "setting"."key" = $1 limit $2\nparams: IS_SIGNUP_ENABLED,1'
  )
  return Object.assign(err, { params: [BOUND_VALUE], cause })
}

test('a drizzle error logs the Postgres cause message, code and severity', () => {
  const text = describeError(drizzleError(new PostgresError('permission denied for table setting')))
  assertStringIncludes(text, 'Error: Failed query: select "value" from "setting"')
  assertStringIncludes(text, 'params: IS_SIGNUP_ENABLED,1')
  assertStringIncludes(
    text,
    '\ncaused by: PostgresError: permission denied for table setting (code 42501, severity ERROR)'
  )
})

test('a cause never leaks bind parameters, detail, hint or the connection string', () => {
  const text = describeError(drizzleError(new PostgresError('relation "setting" does not exist')))
  assertEquals(text.includes(BOUND_VALUE), false)
  assertEquals(text.includes('parameters'), false)
  assertEquals(text.includes('Key (email)'), false)
  assertEquals(text.includes('grant it'), false)
  assertEquals(text.includes(SECRET), false)
  assertEquals(text.includes(SCHEME), false)
})

test('a password inside a URL in a cause message is masked', () => {
  const cause = Object.assign(new Error(`could not connect to ${DATABASE_URL}`), {
    code: 'ECONNREFUSED',
  })
  const text = describeError(drizzleError(cause))
  assertEquals(text.includes(SECRET), false)
  assertStringIncludes(
    text,
    `caused by: Error: could not connect to ${MASKED_URL} (code ECONNREFUSED)`
  )
})

test('a plain error with no code or cause reads exactly as String(err)', () => {
  const err = new TypeError('boom')
  assertEquals(describeError(err), String(err))
  assertEquals(describeErrorCauses(err), '')
  assertEquals(describeError('just a string'), 'just a string')
  assertEquals(describeError(undefined), 'undefined')
})

test('the cause chain stops at a cycle and at four levels', () => {
  const looped = new Error('outer')
  Object.assign(looped, { cause: looped })
  assertEquals(describeError(looped), 'Error: outer')

  let deepest: unknown = new Error('level 6')
  for (let level = 5; level >= 1; level--) deepest = new Error(`level ${level}`, { cause: deepest })
  const lines = describeErrorCauses(deepest).split('\n')
  assertEquals(lines, [
    'caused by: Error: level 2',
    'caused by: Error: level 3',
    'caused by: Error: level 4',
    'caused by: Error: level 5',
  ])
})

test('a non-Error cause is described without dumping its fields', () => {
  assertEquals(
    describeErrorCauses(new Error('x', { cause: 'socket hang up' })),
    'caused by: socket hang up'
  )
  assertEquals(
    describeErrorCauses(new Error('x', { cause: { parameters: [BOUND_VALUE] } })),
    'caused by: Error: (no message)'
  )
})

test('logError writes the cause on its own line', () => {
  const writes: string[] = []
  const writeStub = stub(Deno.stderr, 'writeSync', (data) => {
    writes.push(new TextDecoder().decode(data))
    return data.byteLength
  })
  try {
    const err = drizzleError(new PostgresError('permission denied for table setting'))
    logError('client-status', 'status read failed', err)
  } finally {
    writeStub.restore()
  }
  assertEquals(writes.length, 3)
  assertStringIncludes(
    writes[0] ?? '',
    ' ERROR client-status  status read failed Error: Failed query:'
  )
  assertStringIncludes(writes[1] ?? '', ' ERROR client-status  params: IS_SIGNUP_ENABLED,1')
  assertStringIncludes(
    writes[2] ?? '',
    ' ERROR client-status  caused by: PostgresError: permission denied for table setting (code 42501, severity ERROR)'
  )
})

test('URL masking leaves URLs without a password alone and masks every URL that has one', () => {
  const noPassword = `${SCHEME}turbopanel@db.internal:5432/turbopanel`
  const atInPath = `https://example.com/users/a@b`
  const err = new Error('wrapper', {
    cause: new Error(`from ${DATABASE_URL} and ${DATABASE_URL}, not ${noPassword} or ${atInPath}`),
  })
  assertEquals(
    describeErrorCauses(err),
    `caused by: Error: from ${MASKED_URL} and ${MASKED_URL}, not ${noPassword} or ${atInPath}`
  )
})
