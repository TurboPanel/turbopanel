import { assertEquals, assertStringIncludes } from '@std/assert'
import { unconfirmedErrorText } from './command-recovery.ts'

const test = Deno.test.bind(Deno)

test('a wrapped query error leads with the database reason and drops the bound values', () => {
  const cause = Object.assign(new Error('insert or update violates foreign key constraint'), {
    code: '23503',
  })
  const err = new Error(
    'Failed query: update "command" set "result_summary" = $1 where "id" = $2\nparams: {"secret":"x"},abc',
    { cause }
  )
  const text = unconfirmedErrorText(err)
  assertEquals(text.startsWith('caused by: Error: insert or update violates foreign key constraint'), true)
  assertStringIncludes(text, '23503')
  assertStringIncludes(text, 'Failed query: update "command"')
  assertEquals(text.includes('params:'), false)
  assertEquals(text.includes('secret'), false)
})

test('a plain error reads as its message', () => {
  assertEquals(unconfirmedErrorText(new Error('no deploy context')), 'no deploy context')
  assertEquals(unconfirmedErrorText('boom'), 'boom')
})

test('the text is capped', () => {
  assertEquals(unconfirmedErrorText(new Error('x'.repeat(2000))).length, 600)
})
