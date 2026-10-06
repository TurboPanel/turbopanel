import { assertEquals } from '@std/assert'
import { isCheckViolationOn } from './check-violation.ts'

const test = Deno.test.bind(Deno)

test('finds a check violation on the error or beneath it, by constraint name', () => {
  const pg = { code: '23514', constraint_name: 'entitlement_runtime_check', message: 'x' }
  assertEquals(isCheckViolationOn(pg, 'entitlement_runtime_check'), true)
  assertEquals(
    isCheckViolationOn(
      { message: 'Failed query: insert …', cause: { cause: pg } },
      'entitlement_runtime_check'
    ),
    true
  )
  // The message names it when the driver sets no constraint_name.
  assertEquals(
    isCheckViolationOn(
      { code: '23514', message: 'violates check constraint "entitlement_runtime_check"' },
      'entitlement_runtime_check'
    ),
    true
  )
})

test('another constraint, another code, or no error is not it', () => {
  assertEquals(isCheckViolationOn({ code: '23514', constraint_name: 'other' }, 'a'), false)
  assertEquals(isCheckViolationOn({ code: '23505', constraint_name: 'a' }, 'a'), false)
  assertEquals(isCheckViolationOn(undefined, 'a'), false)
  assertEquals(isCheckViolationOn('boom', 'a'), false)
})
