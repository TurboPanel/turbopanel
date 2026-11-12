/**
 * Host-free coverage for the delete plan's offline refusal wording.
 */

import { assertEquals, assertStringIncludes } from '@std/assert'
import { offlineBlocker, serverLabel } from './delete-plan.ts'

/** Alias for {@link Deno.test} so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const ID = '01a18a23-4e47-71d7-82e1-4e1f68ccb145'

test('serverLabel prefers the name, then the hostname, and never shows the id', () => {
  assertEquals(serverLabel({ name: 'a', hostname: 'a.example.com' }), 'a')
  assertEquals(serverLabel({ name: null, hostname: 'a.example.com' }), 'a.example.com')
  assertEquals(serverLabel({ name: '  ', hostname: 'a.example.com' }), 'a.example.com')
  assertEquals(serverLabel({ name: null, hostname: null }), 'without a name')
})

test('the offline refusal names the server, not its id', () => {
  const blocker = offlineBlocker([
    { id: ID, name: null, hostname: 'a.example.com', connected: false },
  ])
  assertStringIncludes(blocker?.message ?? '', 'Server a.example.com is offline')
  assertEquals(blocker?.message.includes(ID), false)
  assertEquals(blocker?.serverIds, [ID])
  const two = offlineBlocker([
    { id: ID, name: 'a', hostname: null, connected: false },
    { id: 'other', name: 'b', hostname: null, connected: false },
  ])
  assertStringIncludes(two?.message ?? '', 'Servers a, b are offline')
  assertEquals(offlineBlocker([]), null)
})
