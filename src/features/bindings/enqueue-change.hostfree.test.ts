import { assertEquals } from '@std/assert'
import {
  BINDING_PRIVATE_LISTENER_PENDING_WARNING,
  bindingListenerSyncWarning,
  planBindingChangeCommands,
} from './enqueue-change.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('create or remove of a remote consumer plans apply before ingress', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
  assertEquals(plan.ingressServerIds, ['srv-app', 'srv-db'])
})

test('keyPrefix-only PATCH does not plan apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: false,
  })
  assertEquals(plan.apply, false)
  assertEquals(plan.ingressServerIds.includes('srv-app'), true)
})

test('slot-only remote host counts for apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: [],
    affectedConsumerServerIds: ['srv-slot'],
    ingressServerIds: ['srv-slot', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
})

test('last remote binding removed still plans apply so the listener can come down', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-db'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, true)
})

test('bindingListenerSyncWarning is set only when apply was required but did not enqueue', () => {
  assertEquals(bindingListenerSyncWarning({ apply: false }, 'failed'), undefined)
  assertEquals(bindingListenerSyncWarning({ apply: true }, 'enqueued'), undefined)
  assertEquals(
    bindingListenerSyncWarning({ apply: true }, 'failed'),
    BINDING_PRIVATE_LISTENER_PENDING_WARNING
  )
  assertEquals(
    bindingListenerSyncWarning({ apply: true }, 'skipped'),
    BINDING_PRIVATE_LISTENER_PENDING_WARNING
  )
})

test('remote binding change defers ingress when managed.apply does not enqueue', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-app'],
    affectedConsumerServerIds: ['srv-app'],
    ingressServerIds: ['srv-app', 'srv-db'],
    apply: true,
  })
  assertEquals(bindingListenerSyncWarning(plan, 'enqueued'), undefined)
  assertEquals(bindingListenerSyncWarning(plan, 'failed'), BINDING_PRIVATE_LISTENER_PENDING_WARNING)
})

test('co-resident consumer does not plan apply', () => {
  const plan = planBindingChangeCommands({
    memberServerIds: ['srv-db'],
    remainingConsumerServerIds: ['srv-db'],
    affectedConsumerServerIds: ['srv-db'],
    ingressServerIds: ['srv-db'],
    apply: true,
  })
  assertEquals(plan.apply, false)
})
