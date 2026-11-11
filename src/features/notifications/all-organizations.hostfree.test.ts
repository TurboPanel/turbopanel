import { assertEquals } from '@std/assert'
import { parseAllOrganizationsField, refuseOperatorWebhookOff } from './all-organizations.ts'

const test = Deno.test.bind(Deno)

test('an absent field leaves the switch alone', () => {
  assertEquals(parseAllOrganizationsField({}), { ok: true, value: undefined })
  assertEquals(parseAllOrganizationsField(null), { ok: true, value: undefined })
})

test('a boolean sets the switch', () => {
  assertEquals(parseAllOrganizationsField({ allOrganizations: true }), { ok: true, value: true })
  assertEquals(parseAllOrganizationsField({ allOrganizations: false }), { ok: true, value: false })
})

test('anything else is refused', () => {
  for (const bad of ['true', 1, null, {}]) {
    assertEquals(parseAllOrganizationsField({ allOrganizations: bad }), {
      ok: false,
      status: 400,
      error: 'all_organizations_invalid',
    })
  }
})

test('only switching the operator webhook off is refused', () => {
  assertEquals(
    refuseOperatorWebhookOff(true, false)?.error,
    'operator_webhook_hears_all_organizations'
  )
  assertEquals(refuseOperatorWebhookOff(true, true), null)
  assertEquals(refuseOperatorWebhookOff(true, undefined), null)
  assertEquals(refuseOperatorWebhookOff(false, false), null)
})
